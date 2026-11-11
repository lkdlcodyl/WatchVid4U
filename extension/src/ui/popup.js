import { sw, applyTheme, h, icon, toast, errText, t } from './ui.js';
const tt = t; // 部分函数的参数名为 t（任务），用 tt 调用翻译
import { initLang, translateDom } from '../shared/i18n.js';
import { loadSettings, sttTarget, getKey, hasOriginPermission, readiness } from '../shared/settings.js';
import { platformLabel, fmtDuration } from '../shared/format.js';
import { NOTE_MODES } from '../shared/prompts.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let probe = null;
let tasks = []; // 全部任务（进行中 + 最近结束），按开始时间倒序
let limits = { maxConcurrent: 3, capturing: 0 };
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
const CAPTURE_PHASES = new Set(['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'saving', 'needs_action']);

/** 当前标签页的任务：优先进行中的，否则最近结束的 */
function myTask() {
  if (!tab) return null;
  const mine = tasks.filter((t) => t.tabId === tab.id);
  return mine.find((t) => ACTIVE.has(t.phase)) || mine[0] || null;
}

function otherTasks() {
  const me = myTask();
  return tasks.filter((t) => t !== me && (!tab || t.tabId !== tab.id || ACTIVE.has(t.phase)));
}

function capturingCount() {
  return tasks.filter((t) => CAPTURE_PHASES.has(t.phase)).length;
}

init();

async function init() {
  await initLang({ reload: true });
  translateDom(document);
  applyTheme();
  $('btnLib').append(icon('folder'));
  $('btnOpt').append(icon('gear'));
  $('btnFloat').append(icon('float'));
  $('btnLib').onclick = () => { const t = myTask(); sw('open-library', { materialId: t && t.materialId }).then(() => window.close()); };
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
  tasks = st.tasks || [];
  limits = { maxConcurrent: st.maxConcurrent || 3 };
  if (tab) probe = await sw('probe-tab', { tabId: tab.id });
  render();
  renderSetupHint();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session' && ch.tasks) {
      tasks = Object.values(ch.tasks.newValue || {}).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      render();
    }
  });
}

async function start(mode) {
  if (busy || !tab) return;
  busy = true;
  $('btnStart').disabled = $('btnBegin').disabled = true;
  const r = await sw('start', { tabId: tab.id, mode });
  busy = false;
  if (!r.ok && r.error) toast(errText(r.error), 6000);
  if (r.task) tasks = [r.task, ...tasks.filter((t) => t.id !== r.task.id)];
  render();
}

function render() {
  renderPage();
  renderTask();
  renderOthers();
  const mine = myTask();
  const active = mine && ACTIVE.has(mine.phase);
  const full = capturingCount() >= limits.maxConcurrent;
  $('startArea').hidden = !!active;
  $('btnStart').disabled = $('btnBegin').disabled = !probe || !probe.capturable || full;
  $('startHint').textContent =
    probe && !probe.capturable
      ? t('浏览器内置页面、扩展商店等页面无法录制。')
      : full
        ? t('已有 {n} 个标签页在录制，达到同时录制上限（{max} 个）。请等其中一个录完，或在设置中调高上限。', { n: capturingCount(), max: limits.maxConcurrent })
        : t('一次点击：能用字幕就直接保存逐字稿，否则自动录音并在播完后转写。关闭此窗口不影响任务；可在其他标签页同时开始录制。');
}

// 定时刷新录音时长
setInterval(() => {
  if (tasks.some((t) => t.phase === 'recording')) {
    renderTask();
    renderOthers();
  }
}, 1000);

function renderPage() {
  const el = $('page');
  el.replaceChildren();
  if (!tab) return;
  const p = probe && probe.platform ? probe.platform : 'generic';
  const media = probe && probe.media;
  el.append(
    h('div', { class: 'row' }, h('span', { class: 'chip acc', text: platformLabel(p) }), media && media.duration ? h('span', { class: 'chip', text: t('时长 {d}', { d: fmtDuration(media.duration) }) }) : null, media && media.muted ? h('span', { class: 'chip warn', text: '网页静音' }) : null),
    h('div', { class: 'title', text: (probe && probe.title) || tab.title || '当前页面' }),
    h('div', { class: 'cap', text: CAPS[p] }),
  );
}

function renderTask() {
  const area = $('taskArea');
  area.replaceChildren();
  const task = myTask();
  if (!task) return;
  const [label, tone] = PHASE[task.phase] || [task.phase, 'acc'];
  const active = ACTIVE.has(task.phase);
  const elapsed = task.phase === 'recording' ? fmtDuration(task.audio && task.audio.seconds) : '';
  const card = h(
    'div',
    { class: 'card task' },
    h('div', { class: 'task-head' }, h('span', { class: `dot ${tone === 'rec' ? 'rec' : tone}` }), h('div', { class: 'ph' }, label, h('div', { class: 'hint', text: task.phaseText && task.phaseText !== label ? task.phaseText : '' })), elapsed ? h('span', { class: 'time', text: elapsed }) : null, !active ? h('button', { class: 'icon-btn', 'aria-label': '关闭结果', title: '关闭', onclick: () => sw('dismiss-task', { taskId: task.id }) }, icon('close')) : null),
    h('div', { class: 'src', text: t('来源：{src}', { src: `${platformLabel(task.platform)} · ${task.title || t('未命名')}` }) }),
  );
  const id = { taskId: task.id };
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
    actions.append(h('button', { class: 'btn primary', onclick: async () => { const r = await sw('resume-capture', id); if (!r.ok) toast(errText(r.error), 5000); } }, icon('play'), '授权并继续录音'));
    actions.append(h('button', { class: 'btn', onclick: () => sw('cancel', id), text: '取消' }));
  } else if (task.phase === 'recording') {
    actions.append(h('button', { class: 'btn danger', onclick: () => sw('stop', id) }, icon('stop'), '停止并保存'));
    actions.append(h('button', { class: 'btn', onclick: () => sw('cancel', id), text: '取消' }));
  } else if (active) {
    actions.append(h('button', { class: 'btn', onclick: () => sw('cancel', id), text: task.phase === 'transcribing' || task.phase === 'noting' ? '取消后续处理' : '取消' }));
  } else if (task.materialId) {
    actions.append(h('button', { class: 'btn primary', onclick: () => sw('open-library', { materialId: task.materialId }).then(() => window.close()) }, icon('note'), task.phase === 'done' ? '查看逐字稿与笔记' : '查看已保存的材料'));
  }
  if (actions.childNodes.length) card.append(actions);
  if (task.phase === 'recording' || task.phase === 'preparing' || task.phase === 'waiting_ad') {
    const cb = h('input', { type: 'checkbox', checked: task.monitor, onchange: (e) => sw('set-monitor', { ...id, on: e.target.checked }) });
    card.append(h('label', { class: 'mon' }, cb, icon('headphones'), '同时听声音（不影响录音内容）'));
  }
  area.append(card);
}

/** 其他标签页的任务：精简卡片，可停止、取消或切换过去 */
function renderOthers() {
  const area = $('otherArea');
  area.replaceChildren();
  const list = otherTasks();
  if (!list.length) return;
  const act = list.filter((t) => ACTIVE.has(t.phase)).length;
  area.append(
    h(
      'div',
      { class: 'others-head' },
      h('span', { text: act ? t('其他标签页的任务（进行中 {n} 个）', { n: act }) : '其他标签页的任务' }),
      list.some((t) => !ACTIVE.has(t.phase)) ? h('button', { class: 'btn small ghost', text: '清除已结束', onclick: () => list.filter((t) => !ACTIVE.has(t.phase)).forEach((t) => sw('dismiss-task', { taskId: t.id })) }) : null,
    ),
  );
  for (const t of list) area.append(miniCard(t));
}

function miniCard(t) {
  const [label, tone] = PHASE[t.phase] || [t.phase, 'acc'];
  const active = ACTIVE.has(t.phase);
  const id = { taskId: t.id };
  const elapsed = t.phase === 'recording' ? fmtDuration(t.audio && t.audio.seconds) : '';
  const goTo = () => chrome.tabs.update(t.tabId, { active: true }).then((x) => chrome.windows.update(x.windowId, { focused: true })).then(() => window.close()).catch(() => toast('该标签页已关闭'));
  const acts = h('div', { class: 'mini-actions' });
  if (t.phase === 'recording') {
    acts.append(h('button', { class: 'btn small danger', onclick: () => sw('stop', id) }, icon('stop'), '停止并保存'));
    acts.append(h('button', { class: 'btn small', onclick: () => sw('cancel', id), text: '取消' }));
  } else if (t.phase === 'needs_action') {
    // 录音授权必须在该标签页上点击工具栏图标完成
    acts.append(h('button', { class: 'btn small primary', onclick: goTo, text: '前往该页授权' }));
    acts.append(h('button', { class: 'btn small', onclick: () => sw('cancel', id), text: '取消' }));
  } else if (active) {
    acts.append(h('button', { class: 'btn small', onclick: () => sw('cancel', id), text: t.phase === 'transcribing' || t.phase === 'noting' ? '取消后续处理' : '取消' }));
  } else if (t.materialId) {
    acts.append(h('button', { class: 'btn small', onclick: () => sw('open-library', { materialId: t.materialId }).then(() => window.close()) }, icon('note'), '查看'));
  }
  if (active && t.phase !== 'needs_action') acts.append(h('button', { class: 'btn small ghost', onclick: goTo, text: '前往该页' }));
  return h(
    'div',
    { class: 'card mini' },
    h(
      'div',
      { class: 'task-head' },
      h('span', { class: `dot ${tone === 'rec' ? 'rec' : tone}` }),
      h('div', { class: 'mini-main' }, h('div', { class: 'mini-title', text: `${platformLabel(t.platform)} · ${t.title || tt('未命名')}` }), h('div', { class: 'hint', text: t.phaseText && t.phaseText !== label ? `${tt(label)} · ${tt(t.phaseText)}` : label })),
      elapsed ? h('span', { class: 'time', text: elapsed }) : null,
      !active ? h('button', { class: 'icon-btn', 'aria-label': '关闭结果', title: '关闭', onclick: () => sw('dismiss-task', id) }, icon('close')) : null,
    ),
    acts.childNodes.length ? acts : null,
  );
}

function steps(t) {
  const li = (k, v, tone = '') => h('li', null, h('span', { class: 'k', text: k }), h('span', { class: `v ${tone}`, text: v }));
  const out = h('ul', { class: 'steps' });
  if (t.platform === 'bilibili' && t.subtitle && t.subtitle.state !== 'skipped') {
    const s = t.subtitle;
    if (s.state === 'ok') out.append(li('字幕', tt('已获取（{kind}），未调用转写', { kind: tt(s.kindLabel) + (s.lanDoc ? ' · ' + s.lanDoc : '') }), 'ok'));
    else if (s.state === 'failed') out.append(li('字幕', tt('{reason} → 已自动转为录音', { reason: tt(s.reason) }), 'warn'));
    else if (s.state === 'trying') out.append(li('字幕', '获取中…', 'acc'));
  }
  const a = t.audio || {};
  if (a.state && a.state !== 'none') {
    const d = fmtDuration(a.seconds);
    const map = { recording: [tt('录音中 {d}', { d }), 'acc'], stopping: ['正在保存…', 'acc'], saved: [a.endReason === 'manual' ? tt('已保存 {d}（手动停止）', { d }) : tt('已保存 {d}（完整）', { d }), 'ok'], incomplete: [tt('不完整，已保留 {d}', { d }), 'err'] };
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
  if (s.state === 'running') out.append(li('转写', s.total > 1 ? tt('第 {i}/{n} 片', { i: Math.min(s.done + 1, s.total), n: s.total }) : '处理中…', 'acc'));
  else if (s.state === 'queued') out.append(li('转写', s.ahead ? tt('排队中（前面还有 {n} 条）', { n: s.ahead }) : '即将开始', 'acc'));
  else if (s.state === 'done') out.append(li('转写', s.kind === 'speaker' ? '已完成（含说话人分段）' : '已完成', 'ok'));
  else if (s.state === 'failed') out.append(li('转写', s.reason || '失败', 'err'));
  else if (s.state === 'skipped' && t.subtitle && t.subtitle.state !== 'ok') out.append(li('转写', s.reason || '未进行', 'warn'));
  const n = t.note || {};
  if (n.state === 'running') out.append(li('笔记', tt('生成{mode}笔记中…', { mode: NOTE_MODES[n.mode] ? tt(NOTE_MODES[n.mode].label) : '' }), 'acc'));
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
    el.append(h('div', { class: 'notice acc' }, t('{msg}：B站有字幕时不受影响；需要录音转写时请先 ', { msg: t(msg) }), h('a', { href: '#', onclick: (e) => (e.preventDefault(), chrome.runtime.openOptionsPage()), text: '完成设置' }), '。录音仍会保存，配置后可在材料页转写。'));
  }
}

