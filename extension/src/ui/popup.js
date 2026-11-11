import { sw, applyTheme, h, icon, toast, errText } from './ui.js';
import { loadSettings, sttTarget, getKey, hasOriginPermission, readiness } from '../shared/settings.js';
import { platformLabel, fmtDuration } from '../shared/format.js';
import { NOTE_MODES } from '../shared/prompts.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let probe = null;
let task = null;
let busy = false;

const CAPS = {
  bilibili: '优先获取完整字幕（无需等待播放）；没有可用字幕时自动录音，播完自动暂停并转写。',
  youtube: '录音转写；广告结束后才算正文起点，播完自动暂停并阻止自动下一条。',
  douyin: '录音转写；播完自动暂停并阻止从头循环。',
  generic: '录制本标签页的声音；找到视频/音频时可自动在播完后停止。',
};

const PHASE = {
  detecting: ['正在识别视频', 'acc'],
  subtitle: ['正在获取字幕', 'acc'],
  preparing: ['正在准备录音', 'acc'],
  waiting_ad: ['等待广告结束', 'warn'],
  recording: ['录音中', 'rec'],
  saving: ['正在保存录音', 'acc'],
  transcribing: ['正在转写', 'acc'],
  noting: ['正在生成笔记', 'acc'],
  needs_action: ['需要你授权录音', 'warn'],
  done: ['已完成', 'ok'],
  failed: ['失败', 'err'],
  cancelled: ['已取消', 'warn'],
  interrupted: ['已中断', 'err'],
};
const ACTIVE = new Set(['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'saving', 'transcribing', 'noting', 'needs_action']);

init();

async function init() {
  applyTheme();
  $('btnLib').append(icon('folder'));
  $('btnOpt').append(icon('gear'));
  $('btnFloat').append(icon('float'));
  $('btnLib').onclick = () => sw('open-library', { materialId: task && task.materialId }).then(() => window.close());
  $('btnOpt').onclick = () => chrome.runtime.openOptionsPage();
  $('btnStart').append(icon('play'), h('span', null, '开始录制'), h('small', { text: '从当前进度' }));
  $('btnBegin').append(icon('restart'), h('span', null, '从头录制'), h('small', { text: '从正文开头' }));
  $('btnStart').onclick = () => start('current');
  $('btnBegin').onclick = () => start('beginning');
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('btnFloat').onclick = async () => {
    if (!tab) return;
    const r = await sw('toggle-float', { tabId: tab.id });
    toast(r && r.ok ? (r.visible ? '浮窗已显示' : '浮窗已隐藏') : errText(r.error) || '此页面无法显示浮窗');
  };
  const st = await sw('get-state');
  task = st.task || null;
  if (tab) probe = await sw('probe-tab', { tabId: tab.id });
  render();
  renderSetupHint();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session' && ch.task) {
      task = ch.task.newValue || null;
      render();
    }
  });
  setInterval(() => task && task.phase === 'recording' && renderTask(), 1000);
}

async function start(mode) {
  if (busy || !tab) return;
  busy = true;
  $('btnStart').disabled = $('btnBegin').disabled = true;
  const r = await sw('start', { tabId: tab.id, mode });
  busy = false;
  if (!r.ok && r.error) toast(errText(r.error), 6000);
  if (r.task) task = r.task;
  render();
}

function render() {
  renderPage();
  renderTask();
  const active = task && ACTIVE.has(task.phase);
  $('startArea').hidden = !!active;
  $('btnStart').disabled = $('btnBegin').disabled = !probe || !probe.capturable;
  $('startHint').textContent = probe && !probe.capturable ? '浏览器内置页面、扩展商店等页面无法录制。' : '一次点击：能用字幕就直接保存逐字稿，否则自动录音并在播完后转写。关闭此窗口不影响任务。';
}

function renderPage() {
  const el = $('page');
  el.replaceChildren();
  if (!tab) return;
  const p = probe && probe.platform ? probe.platform : 'generic';
  const media = probe && probe.media;
  el.append(
    h('div', { class: 'row' }, h('span', { class: 'chip acc', text: platformLabel(p) }), media && media.duration ? h('span', { class: 'chip', text: `时长 ${fmtDuration(media.duration)}` }) : null, media && media.muted ? h('span', { class: 'chip warn', text: '网页静音' }) : null),
    h('div', { class: 'title', text: (probe && probe.title) || tab.title || '当前页面' }),
    h('div', { class: 'cap', text: CAPS[p] }),
  );
}

function renderTask() {
  const area = $('taskArea');
  area.replaceChildren();
  if (!task) return;
  const [label, tone] = PHASE[task.phase] || [task.phase, 'acc'];
  const active = ACTIVE.has(task.phase);
  const otherTab = active && tab && task.tabId !== tab.id;
  const elapsed = task.phase === 'recording' ? fmtDuration(task.audio && task.audio.seconds) : '';
  const card = h(
    'div',
    { class: 'card task' },
    h('div', { class: 'task-head' }, h('span', { class: `dot ${tone === 'rec' ? 'rec' : tone}` }), h('div', { class: 'ph' }, label, h('div', { class: 'hint', text: task.phaseText && task.phaseText !== label ? task.phaseText : '' })), elapsed ? h('span', { class: 'time', text: elapsed }) : null, !active ? h('button', { class: 'icon-btn', 'aria-label': '关闭结果', title: '关闭', onclick: () => sw('dismiss-task') }, icon('close')) : null),
    h('div', { class: 'src', text: `${otherTab ? '来源（另一个标签页）' : '来源'}：${platformLabel(task.platform)} · ${task.title || '未命名'}` }),
  );
  if (task.stt && task.stt.state === 'running') {
    const pct = task.stt.total ? Math.round((task.stt.done / task.stt.total) * 100) : 0;
    card.append(h('div', { class: `progress ${task.stt.total ? '' : 'indet'}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-label': '转写进度' }, h('i', { style: `width:${pct}%` })));
  } else if (['detecting', 'subtitle', 'preparing', 'saving', 'noting', 'waiting_ad'].includes(task.phase)) {
    card.append(h('div', { class: 'progress indet', role: 'progressbar', 'aria-label': '处理中' }, h('i')));
  }
  card.append(steps(task));
  if (task.warnings && task.warnings.length) card.append(h('div', { class: 'warns' }, task.warnings.map((w) => h('div', { class: 'notice warn', text: w }))));
  if (task.error && (task.phase === 'failed' || task.phase === 'interrupted' || task.phase === 'needs_action')) card.append(h('div', { class: `notice ${task.phase === 'needs_action' ? 'warn' : 'err'}`, text: errText(task.error) }));
  const actions = h('div', { class: 'task-actions' });
  if (task.phase === 'needs_action') {
    actions.append(h('button', { class: 'btn primary', onclick: async () => { const r = await sw('resume-capture'); if (!r.ok) toast(errText(r.error), 5000); } }, icon('play'), '授权并继续录音'));
    actions.append(h('button', { class: 'btn', onclick: () => sw('cancel'), text: '取消' }));
  } else if (task.phase === 'recording') {
    actions.append(h('button', { class: 'btn danger', onclick: () => sw('stop') }, icon('stop'), '停止并保存'));
    actions.append(h('button', { class: 'btn', onclick: () => sw('cancel'), text: '取消' }));
  } else if (active) {
    actions.append(h('button', { class: 'btn', onclick: () => sw('cancel'), text: task.phase === 'transcribing' || task.phase === 'noting' ? '取消后续处理' : '取消' }));
  } else if (task.materialId) {
    actions.append(h('button', { class: 'btn primary', onclick: () => sw('open-library', { materialId: task.materialId }).then(() => window.close()) }, icon('note'), task.phase === 'done' ? '查看逐字稿与笔记' : '查看已保存的材料'));
  }
  if (actions.childNodes.length) card.append(actions);
  if (task.phase === 'recording' || task.phase === 'preparing' || task.phase === 'waiting_ad') {
    const cb = h('input', { type: 'checkbox', checked: task.monitor, onchange: (e) => sw('set-monitor', { on: e.target.checked }) });
    card.append(h('label', { class: 'mon' }, cb, icon('headphones'), '同时听声音（不影响录音内容）'));
  }
  area.append(card);
}

function steps(t) {
  const li = (k, v, tone = '') => h('li', null, h('span', { class: 'k', text: k }), h('span', { class: `v ${tone}`, text: v }));
  const out = h('ul', { class: 'steps' });
  if (t.platform === 'bilibili' && t.subtitle && t.subtitle.state !== 'skipped') {
    const s = t.subtitle;
    if (s.state === 'ok') out.append(li('字幕', `已获取（${s.kindLabel}${s.lanDoc ? ' · ' + s.lanDoc : ''}），未调用转写`, 'ok'));
    else if (s.state === 'failed') out.append(li('字幕', `${s.reason} → 已自动转为录音`, 'warn'));
    else if (s.state === 'trying') out.append(li('字幕', '获取中…', 'acc'));
  }
  const a = t.audio || {};
  if (a.state && a.state !== 'none') {
    const map = { recording: ['录音中 ' + fmtDuration(a.seconds), 'acc'], stopping: ['正在保存…', 'acc'], saved: [`已保存 ${fmtDuration(a.seconds)}${a.endReason === 'manual' ? '（手动停止）' : '（完整）'}`, 'ok'], incomplete: [`不完整，已保留 ${fmtDuration(a.seconds)}`, 'err'] };
    const [v, tone] = map[a.state] || [a.state, ''];
    out.append(li('音频', v, tone));
  }
  const p = t.playback || {};
  if (p.state && !['unknown', 'not_applicable'].includes(p.state)) {
    const map = { playing: ['播放中', 'acc'], blocked: ['等待你在网页上点播放', 'warn'], guarded: [p.detail || '已暂停并保持', 'ok'], paused: [p.detail || '已暂停', 'ok'], released: [p.detail || '已由你继续播放', ''], failed: [p.detail || '未能暂停', 'err'] };
    const [v, tone] = map[p.state] || [p.state, ''];
    out.append(li('网页播放', v, tone));
  }
  const s = t.stt || {};
  if (s.state === 'running') out.append(li('转写', s.total > 1 ? `第 ${Math.min(s.done + 1, s.total)}/${s.total} 片` : '处理中…', 'acc'));
  else if (s.state === 'done') out.append(li('转写', `已完成${s.kind === 'speaker' ? '（含说话人分段）' : ''}`, 'ok'));
  else if (s.state === 'failed') out.append(li('转写', s.reason || '失败', 'err'));
  else if (s.state === 'skipped' && t.subtitle && t.subtitle.state !== 'ok') out.append(li('转写', s.reason || '未进行', 'warn'));
  const n = t.note || {};
  if (n.state === 'running') out.append(li('笔记', `生成${NOTE_MODES[n.mode] ? NOTE_MODES[n.mode].label : ''}笔记中…`, 'acc'));
  else if (n.state === 'done') out.append(li('笔记', '已生成', 'ok'));
  else if (n.state === 'failed') out.append(li('笔记', n.reason || '失败', 'err'));
  else if (n.state === 'skipped') out.append(li('笔记', n.reason || '未生成', 'warn'));
  return out;
}

async function renderSetupHint() {
  const el = $('setupHint');
  const s = await loadSettings();
  const target = sttTarget(s);
  const key = await getKey(target.keyService, target.endpoint);
  const perm = await hasOriginPermission(target.endpoint);
  const rd = readiness(target, key, perm);
  el.replaceChildren();
  if (!rd.ok) {
    const msg = rd.code === 'not_configured' ? '尚未配置语音转写服务' : rd.code === 'key_missing' ? '转写服务的 Key 未保存在本次会话中' : '转写服务尚未完成授权';
    el.append(h('div', { class: 'notice acc' }, `${msg}：B站有字幕时不受影响；需要录音转写时请先 `, h('a', { href: '#', onclick: (e) => (e.preventDefault(), chrome.runtime.openOptionsPage()), text: '完成设置' }), '。录音仍会保存，配置后可在材料页转写。'));
  }
}
