import { sw, applyTheme, h, icon, toast, confirmDialog, copyText, downloadBlob, errText, t as tt } from './ui.js';
import { initLang, translateDom } from '../shared/i18n.js';
import { listMaterials, getChunks, getFrames, deleteMaterials, onMaterialsChanged, getRaw, AUDIO_CACHE_LIMIT, audioBytesOf } from '../shared/db.js';
import { fmtTs } from '../shared/frames.js';
import { wavBlobAll, SAMPLE_RATE } from '../shared/wav.js';
import { renderMarkdownInto } from '../shared/markdown.js';
import { NOTE_MODES } from '../shared/prompts.js';
import { platformLabel, fmtDuration, fmtTime, fmtBytes, safeFilename, countChars } from '../shared/format.js';
import { stagePrefix } from '../shared/errors.js';

const $ = (id) => document.getElementById(id);
let materials = [];
let selectedId = null;
const checked = new Set();
let filter = 'all';
const tabByMaterial = new Map();
const modeByMaterial = new Map();
let audioUrl = null;
let frameUrls = [];
let renderedDetailKey = '';

init();

async function init() {
  await initLang({ reload: true });
  translateDom(document);
  applyTheme();
  $('lnkOpt').append(icon('gear'));
  selectedId = decodeURIComponent(location.hash.slice(1)) || null;
  if (selectedId) document.getElementById('app').classList.add('show-detail');
  document.querySelectorAll('.filters button').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.f;
      document.querySelectorAll('.filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderList();
    }),
  );
  $('selAll').addEventListener('change', (e) => {
    const vis = visible();
    if (e.target.checked) vis.forEach((m) => checked.add(m.id));
    else checked.clear();
    renderList();
  });
  $('btnDelete').addEventListener('click', batchDelete);
  $('btnExport').addEventListener('click', batchExport);
  window.addEventListener('hashchange', () => {
    selectedId = decodeURIComponent(location.hash.slice(1)) || null;
    renderAll();
  });
  onMaterialsChanged(() => reload());
  await reload();
}

async function reload() {
  materials = await listMaterials();
  if (selectedId && !materials.some((m) => m.id === selectedId)) selectedId = null;
  for (const id of [...checked]) if (!materials.some((m) => m.id === id)) checked.delete(id);
  renderAll();
}

function renderAll() {
  renderList();
  renderDetail();
  const total = materials.reduce((s, m) => s + audioBytesOf(m), 0);
  $('cacheInfo').textContent = tt('音频缓存 {used} / 约 {limit} · 超出时自动清理最旧的已转写音频，文字保留', { used: fmtBytes(total), limit: fmtBytes(AUDIO_CACHE_LIMIT) });
}

function visible() {
  return materials.filter((m) => {
    if (filter === 'text') return !!(m.transcript && m.transcript.effective);
    if (filter === 'audio') return !m.transcript && m.audio && !m.audio.purged && m.status !== 'recording';
    if (filter === 'problem') return m.status === 'incomplete' || !!m.lastError || !!m.sttPartial;
    return true;
  });
}

function statusChips(m) {
  const out = [];
  if (m.source === 'subtitle') out.push(h('span', { class: 'chip acc', text: m.subtitle ? tt(m.subtitle.kindLabel) : '字幕' }));
  else out.push(h('span', { class: 'chip', text: '录音' }));
  if (m.status === 'recording') out.push(h('span', { class: 'chip rec', text: '录音中' }));
  else if (m.processing) {
    const p = m.processing.progress;
    out.push(h('span', { class: 'chip acc', text: m.processing.kind === 'stt' ? (m.processing.queued ? '排队等待转写' : p && p.total > 1 ? tt('转写中 {done}/{total}', p) : '转写中') : '生成笔记中' }));
  } else if (m.transcript) out.push(h('span', { class: 'chip ok', text: m.transcript.kind === 'speaker' ? '逐字稿 · 多人' : '逐字稿' }));
  else if (m.status === 'incomplete') out.push(h('span', { class: 'chip err', text: '不完整' }));
  else if (m.audio) out.push(h('span', { class: 'chip warn', text: '待转写' }));
  const nn = m.notes ? Object.keys(m.notes).length : 0;
  if (nn) out.push(h('span', { class: 'chip', text: tt('笔记 {n}', { n: nn }) }));
  if (m.lastError && !m.processing) out.push(m.lastError.code === 'cancelled' ? h('span', { class: 'chip warn', text: '已取消' }) : h('span', { class: 'chip err', text: '有失败' }));
  return out;
}

function renderList() {
  const list = $('list');
  const vis = visible();
  list.replaceChildren();
  if (!materials.length) {
    list.append(h('li', { class: 'empty' }, h('h2', { text: '还没有材料' }), h('p', { text: '在视频页点击工具栏图标或浮窗中的“开始录制”，完成后逐字稿会出现在这里。' })));
  } else if (!vis.length) {
    list.append(h('li', { class: 'empty', text: '没有符合筛选条件的材料' }));
  }
  for (const m of vis) {
    const cb = h('input', { type: 'checkbox', checked: checked.has(m.id), 'aria-label': tt('选择：{title}', { title: m.title || tt('未命名') }), onclick: (e) => e.stopPropagation(), onchange: (e) => (e.target.checked ? checked.add(m.id) : checked.delete(m.id), updateSel()) });
    const li = h(
      'li',
      { class: 'item', role: 'option', 'aria-selected': String(m.id === selectedId), tabindex: '0', onclick: () => select(m.id), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select(m.id)) },
      cb,
      h('div', null, h('div', { class: 't', text: m.title || '未命名' }), h('div', { class: 'm' }, h('span', { text: `${platformLabel(m.platform)} · ${fmtTime(m.createdAt)}` }), ...statusChips(m))),
    );
    list.append(li);
  }
  updateSel();
}

function updateSel() {
  const n = checked.size;
  $('selInfo').textContent = n ? tt('已选 {n} 条', { n }) : '';
  $('btnDelete').disabled = $('btnExport').disabled = !n;
  const vis = visible();
  $('selAll').checked = vis.length > 0 && vis.every((m) => checked.has(m.id));
  $('selAll').indeterminate = n > 0 && !$('selAll').checked;
}

function select(id) {
  selectedId = id;
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  document.getElementById('app').classList.add('show-detail');
  renderList();
  renderDetail(true);
  $('detail').focus();
}

// ---------------- 详情 ----------------

function renderDetail(force = false) {
  const el = $('detail');
  const m = materials.find((x) => x.id === selectedId);
  // 避免同一材料无关更新导致音频播放器被重建
  const key = m ? `${m.id}|${m.updatedAt}|${tabByMaterial.get(m.id)}|${modeByMaterial.get(m.id)}` : 'none';
  if (!force && key === renderedDetailKey) return;
  const keepAudio = m && renderedDetailKey.startsWith(m.id + '|') && (tabByMaterial.get(m.id) || 'transcript') === 'audio' && !force;
  renderedDetailKey = key;
  if (!m) {
    revokeAudio();
    el.replaceChildren(h('div', { class: 'empty' }, h('h2', { text: materials.length ? '选择一条材料' : '欢迎使用 WatchVid4U' }), h('p', { text: materials.length ? '左侧选择材料后，可阅读逐字稿与笔记、试听音频、继续处理或导出。' : '完成一次任务后，这里会显示逐字稿与笔记。' })));
    return;
  }
  if (!keepAudio) revokeAudio();
  const tab = tabByMaterial.get(m.id) || (m.transcript ? 'transcript' : 'audio');
  el.replaceChildren(
    h('button', { class: 'btn small ghost back', onclick: () => document.getElementById('app').classList.remove('show-detail') }, icon('back'), '返回列表'),
    head(m),
    notices(m),
    actions(m),
    tabs(m, tab),
    pane(m, tab),
  );
}

function head(m) {
  const dur = m.audio && m.audio.samples ? m.audio.samples / (m.audio.sampleRate || SAMPLE_RATE) : m.subtitle ? m.subtitle.lastTo : null;
  return h(
    'header',
    { class: 'd-head' },
    h('h2', { text: m.title || '未命名' }),
    h('div', { class: 'd-meta' }, h('span', { text: platformLabel(m.platform) }), h('span', { text: '·' }), h('span', { text: fmtTime(m.createdAt) }), dur ? h('span', { text: `· ${fmtDuration(dur)}` }) : null, ...statusChips(m)),
  );
}

function notices(m) {
  const box = h('div', { class: 'd-notices' });
  if (m.status === 'recording') box.append(h('div', { class: 'notice acc', text: '仍在录音中。任务结束后会自动更新。' }));
  if (m.processing) {
    const p = m.processing.progress;
    box.append(h('div', { class: 'notice acc', text: m.processing.kind === 'stt' && m.processing.queued ? '排队等待转写：前面的录音转写完成后会自动开始。可关闭此页，处理在后台继续。' : m.processing.kind === 'stt' ? (p && p.total ? tt('正在转写（{done}/{total} 片）…可关闭此页，处理在后台继续。', p) : '正在转写…可关闭此页，处理在后台继续。') : tt('正在生成{mode}笔记…', { mode: NOTE_MODES[m.processing.mode] ? tt(NOTE_MODES[m.processing.mode].label) : '' }) }));
  }
  if (m.status === 'incomplete') box.append(h('div', { class: 'notice warn', text: m.audio && m.audio.endDetail ? tt('这段录音不完整（{why}）：只包含中断前已录下的部分，未自动转写。可试听后决定是否转写。', { why: tt(m.audio.endDetail) }) : '这段录音不完整：只包含中断前已录下的部分，未自动转写。可试听后决定是否转写。' }));
  if (m.audio && m.audio.complete && m.audio.endReason === 'manual') box.append(h('div', { class: 'notice', text: '此录音由你手动停止，只包含停止前的内容。' }));
  if (m.sttPartial && !m.processing) {
    const done = m.sttPartial.results.filter((r) => !r.silent).length;
    box.append(h('div', { class: 'notice warn', text: tt('上次转写未完成：已完成 {done} 片', { done }) + (m.sttPartial.failedAt != null ? tt('，在第 {i}/{n} 片失败', { i: m.sttPartial.failedAt + 1, n: m.sttPartial.totalSlices }) : '') + tt('。点击“继续转写”只处理剩余分片') + (m.transcript ? tt('；现有完整逐字稿不会被覆盖，直到新结果全部完成') : '') + tt('。') }));
  }
  if (m.lastError && !m.processing) box.append(h('div', { class: 'notice err', text: `${stagePrefix(m.lastError.stage)}${errText(m.lastError)}${m.lastError.diag && m.lastError.diag.status ? ` · HTTP ${m.lastError.diag.status}` : ''}${m.lastError.diag && m.lastError.diag.contentType ? ` · ${m.lastError.diag.contentType}` : ''}${m.lastError.diag && m.lastError.diag.length != null ? ' · ' + tt('{n} 字节', { n: m.lastError.diag.length }) : ''}` }));
  if (m.subtitleAttempt) box.append(h('div', { class: 'notice', text: tt('字幕未采用：{reason}，因此改为录音。', { reason: tt(m.subtitleAttempt.reason) }) }));
  if (m.audio && m.audio.purged) box.append(h('div', { class: 'notice', text: '音频已因缓存上限被清理；逐字稿和笔记仍可阅读、导出和重新生成笔记。' }));
  return box;
}

function actions(m) {
  const bar = h('div', { class: 'd-actions' });
  const canStt = m.audio && !m.audio.purged && m.status !== 'recording' && !m.processing;
  if (m.processing) {
    bar.append(h('button', { class: 'btn', onclick: async () => { await sw('material-cancel', { materialId: m.id }); toast('已请求取消（服务商可能仍会处理已发送的请求）'); } }, '取消处理'));
    return bar;
  }
  if (canStt) {
    const label = m.sttPartial ? '继续转写' : m.transcript && m.transcript.source === 'stt' ? '重新转写' : '转写为逐字稿';
    bar.append(h('button', { class: `btn ${m.transcript ? '' : 'primary'}`, onclick: () => transcribe(m) }, label));
  }
  // 笔记的风格选择与生成放在“笔记”标签内（风格选择器旁边），这里只提供入口
  if (m.transcript && (tabByMaterial.get(m.id) || 'transcript') !== 'notes') {
    bar.append(h('button', { class: 'btn', onclick: () => { tabByMaterial.set(m.id, 'notes'); renderDetail(true); } }, icon('note'), m.notes && Object.keys(m.notes).length ? '查看 / 生成笔记' : '生成笔记…'));
  }
  return bar;
}

async function transcribe(m) {
  if (m.status === 'incomplete') {
    const ok = await confirmDialog({ title: '转写不完整的录音？', body: '这段录音在中断前停止，转写结果只对应已录到的部分。将把音频发送给你已授权的转写服务（可能计费）。', ok: '仍然转写' });
    if (!ok) return;
  } else if (m.transcript && !m.sttPartial) {
    const ok = await confirmDialog({ title: '重新转写？', body: '将再次把音频发送给转写服务（长音频会分片多次请求，可能分别计费）。新结果全部完成后才会替换当前逐字稿；失败不影响现有内容。', ok: '重新转写' });
    if (!ok) return;
  }
  const r = await sw('material-transcribe', { materialId: m.id });
  if (!r.ok) toast(errText(r.error), 6000);
  else toast(r.queued ? '已加入转写队列，前面的转写完成后自动开始' : '已开始转写，可关闭此页');
}

async function generateNote(m, mode) {
  const r = await sw('material-note', { materialId: m.id, mode });
  if (!r.ok) toast(errText(r.error), 6000);
  else {
    tabByMaterial.set(m.id, 'notes');
    modeByMaterial.set(m.id, mode);
    toast(tt('正在生成{mode}笔记…', { mode: tt(NOTE_MODES[mode].label) }));
  }
}

function tabs(m, cur) {
  const defs = [
    ['transcript', '逐字稿'],
    ['notes', tt('笔记') + (m.notes && Object.keys(m.notes).length ? ` (${Object.keys(m.notes).length})` : '')],
    ['audio', m.source === 'subtitle' ? '字幕来源' : '音频与来源'],
  ];
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  for (const [k, label] of defs) {
    bar.append(
      h('button', {
        role: 'tab',
        'aria-selected': String(k === cur),
        tabindex: k === cur ? '0' : '-1',
        text: label,
        onclick: () => {
          tabByMaterial.set(m.id, k);
          renderDetail(true);
        },
        onkeydown: (e) => {
          const i = defs.findIndex((d) => d[0] === k);
          const n = e.key === 'ArrowRight' ? defs[(i + 1) % defs.length] : e.key === 'ArrowLeft' ? defs[(i + defs.length - 1) % defs.length] : null;
          if (n) {
            tabByMaterial.set(m.id, n[0]);
            renderDetail(true);
            document.querySelector('.tabs [aria-selected="true"]')?.focus();
          }
        },
      }),
    );
  }
  return bar;
}

function pane(m, tab) {
  try {
    if (tab === 'notes') return notesPane(m);
    if (tab === 'audio') return audioPane(m);
    return transcriptPane(m);
  } catch (e) {
    // 渲染异常时仍保证逐字稿可读、可复制
    return h('pre', { class: 'prose transcript', text: m.transcript ? m.transcript.effective : '' });
  }
}

function transcriptPane(m) {
  const box = h('section', { role: 'tabpanel' });
  const t = m.transcript;
  if (!t) {
    box.append(h('p', { class: 'hint', text: m.audio ? '还没有逐字稿。点击上方“转写为逐字稿”。' : '没有可用的逐字稿。' }));
    return box;
  }
  const filename = safeFilename(m.title);
  box.append(
    h(
      'div',
      { class: 'pane-tools' },
      h('span', { class: 'chip', text: t.source === 'subtitle' ? tt('来自{src}', { src: tt(m.subtitle ? m.subtitle.kindLabel : '字幕') }) : tt('语音转写') + (t.model ? ' · ' + t.model : '') }),
      t.kind === 'speaker' ? h('span', { class: 'chip acc', text: '按说话人分段（匿名）' }) : null,
      h('span', { class: 'hint', text: tt('{n} 字', { n: countChars(t.effective) }) }),
      t.droppedSegments ? h('span', { class: 'hint', text: tt('· 按模型置信度省略 {n} 段疑似无语音内容', { n: t.droppedSegments }) }) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => copyText(t.effective) }, icon('copy'), '复制'),
      h('button', { class: 'btn small', onclick: () => downloadBlob(new Blob([t.effective], { type: 'text/plain;charset=utf-8' }), `${filename}.txt`) }, icon('download'), 'TXT'),
    ),
  );
  if (t.sttMeta && t.sttMeta.speakers && t.sttMeta.speakers.error) box.append(h('div', { class: 'notice', text: '说话人区分未成功，已显示完整的普通逐字稿。' }));
  if (t.sttMeta && t.sttMeta.partialAudio) box.append(h('div', { class: 'notice warn', text: '此逐字稿来自不完整的录音，只对应已录到的部分。' }));
  box.append(h('div', { class: 'prose transcript', text: t.effective }));
  return box;
}

function notesPane(m) {
  const box = h('section', { role: 'tabpanel' });
  if (!m.transcript) {
    box.append(h('p', { class: 'hint', text: '需要先有逐字稿才能生成笔记。' }));
    return box;
  }
  const mode = modeByMaterial.get(m.id) || m.lastNoteMode || 'concise';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'noteStyleLabel' });
  for (const [k, v] of Object.entries(NOTE_MODES)) {
    seg.append(
      h('button', {
        'aria-pressed': String(k === mode),
        title: v.hint,
        text: v.label + (m.notes && m.notes[k] ? ' ●' : ''),
        onclick: () => {
          modeByMaterial.set(m.id, k); // 切换模式只显示已有笔记，不自动联网
          renderDetail(true);
        },
      }),
    );
  }
  const note = m.notes && m.notes[mode];
  const genLabel = tt(note ? '重新生成{mode}笔记' : '生成{mode}笔记', { mode: tt(NOTE_MODES[mode].label) });
  // 第一行：选择风格 → 紧挨着的生成按钮（先选后做）
  box.append(
    h(
      'div',
      { class: 'note-gen' },
      h('span', { class: 'note-gen-label', id: 'noteStyleLabel', text: '笔记风格' }),
      seg,
      h('button', { class: `btn ${note ? '' : 'primary'}`, disabled: !!m.processing, onclick: () => generateNote(m, mode) }, icon('note'), m.processing && m.processing.kind === 'llm' ? '生成中…' : genLabel),
    ),
    h('p', { class: 'hint note-gen-hint', text: tt('{hint}。切换风格只显示已有笔记，不会自动联网；带 ● 的风格已有笔记。', { hint: tt(NOTE_MODES[mode].hint) }) }),
  );
  if (!note) {
    box.append(h('div', { class: 'notice', text: tt('还没有{mode}笔记，点击上方“{btn}”即可生成。', { mode: tt(NOTE_MODES[mode].label), btn: genLabel }) }));
    return box;
  }
  // 第二行：这份笔记的信息与导出
  box.append(
    h(
      'div',
      { class: 'pane-tools' },
      h('span', { class: 'hint', text: tt('生成于 {time}', { time: fmtTime(note.createdAt) }) + (note.model ? ' · ' + note.model : '') + (note.adEvidence ? tt(' · 已按播放器检测到的广告时段排除平台广告') : '') + (note.frames ? tt(' · 模型参考了 {n} 张截图', { n: note.frames }) : '') }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => copyText(note.markdown) }, icon('copy'), '复制 Markdown'),
      h('button', { class: 'btn small', onclick: () => downloadBlob(new Blob([note.markdown], { type: 'text/markdown;charset=utf-8' }), `${safeFilename(m.title)}-${tt(NOTE_MODES[mode].label)}${tt('笔记')}.md`) }, icon('download'), '.md'),
    ),
  )
  if ((note.transcriptVersion || 1) !== (m.transcriptVersion || 1) || (note.transcriptKind && note.transcriptKind !== m.transcript.kind)) {
    box.append(h('div', { class: 'notice warn', text: '逐字稿在这份笔记生成之后已更新，笔记可能已过期。需要时可点击上方“重新生成”（不会自动重跑）。' }));
  }
  const article = h('article', { class: 'prose' });
  renderMarkdownInto(article, note.markdown);
  box.append(article);
  return box;
}

function audioPane(m) {
  const box = h('section', { role: 'tabpanel' });
  const dl = h('dl', { class: 'kv' });
  const kv = (k, v) => v != null && v !== '' && dl.append(h('dt', { text: k }), h('dd', null, v));
  kv('平台', platformLabel(m.platform));
  if (m.pageUrl && /^https?:/.test(m.pageUrl)) kv('原页面', h('a', { href: m.pageUrl, target: '_blank', rel: 'noopener noreferrer', text: m.pageUrl.length > 80 ? m.pageUrl.slice(0, 80) + '…' : m.pageUrl }));
  if (m.subtitle) {
    const s = m.subtitle;
    kv('字幕类型', tt(s.kindLabel) + (s.kind === 'unknown' ? tt('（接口未明确标注是否人工）') : ''));
    kv('字幕语言', s.lanDoc || s.lan);
    kv('字幕行数', tt('{n} 行，覆盖至 {to}', { n: s.lines, to: fmtDuration(s.lastTo) }) + (s.video && s.video.duration ? tt(' / 视频 {d}', { d: fmtDuration(s.video.duration) }) : ''));
    if (s.video) kv('视频标识', `${s.video.bvid || 'av' + s.video.aid} · P${s.video.p} · cid ${s.video.cid}`);
    if (s.available && s.available.length) kv('可用轨道', s.available.map((a) => `${a.lanDoc}(${tt(a.kind === 'manual' ? '人工' : a.kind === 'auto' ? '自动' : '未知')})`).join(tt('、')));
    kv('登录状态', s.usedLogin ? '使用了浏览器中的 B站登录状态' : '未使用登录状态');
    box.append(dl);
    box.append(h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => exportRawSubtitle(m) }, icon('download'), '导出原始字幕 JSON')));
    return box;
  }
  if (m.audio) {
    const a = m.audio;
    kv('起点', a.startMode === 'beginning' ? '从头' : tt('从当前进度（{t}）', { t: fmtDuration(a.startOffsetSec) }));
    kv('结束方式', { ended: '播放到正文结尾（自动）', manual: '手动停止', interrupted: '异常中断', cancelled: '已取消' }[a.endReason] || (m.status === 'recording' ? '录音中' : '—'));
    if (a.adIntervals && a.adIntervals.length) kv('平台广告', tt('录音中检测到 {n} 段（{list}），音频未裁剪', { n: a.adIntervals.length, list: a.adIntervals.map(([s, e]) => `${fmtDuration(s)}–${fmtDuration(e)}`).join(tt('，')) }));
    kv('音频格式', tt('WAV · {khz} kHz 单声道 · {size}', { khz: (a.sampleRate || SAMPLE_RATE) / 1000, size: fmtBytes(a.bytes || 0) }));
    box.append(dl);
    if (m.frames && m.frames.count) box.append(framesGallery(m));
    if (a.purged) return box;
    // 只提供试听，不提供音频文件下载：录音只是生成逐字稿的中间材料（也隐藏播放器自带的下载项）
    const player = h('audio', { controls: true, preload: 'metadata', controlslist: 'nodownload', 'aria-label': '录音试听', oncontextmenu: (e) => e.preventDefault() });
    const info = h('p', { class: 'hint' });
    box.append(player, info);
    loadAudio(m, player, info);
  }
  return box;
}

/** 录制时截取的画面：缩略图网格，点击在新标签页查看原图 */
function framesGallery(m) {
  const f = m.frames;
  const grid = h('div', { class: 'frames' });
  const wrap = h(
    'div',
    { class: 'frames-wrap' },
    h('h3', { class: 'frames-h', text: tt('录制画面（{n} 张，约每 {sec} 秒，{size}）', { n: f.count, sec: f.intervalSec, size: fmtBytes(f.bytes || 0) }) }),
    f.blank ? h('p', { class: 'hint', text: tt('另有 {n} 次截到黑屏（可能是受保护内容或加载中），已跳过。', { n: f.blank }) }) : null,
    grid,
  );
  getFrames(m.id)
    .then((list) => {
      for (const u of frameUrls) URL.revokeObjectURL(u);
      frameUrls = [];
      for (const fr of list) {
        const url = URL.createObjectURL(fr.blob);
        frameUrls.push(url);
        grid.append(h('a', { class: 'frame', href: url, target: '_blank', rel: 'noopener', title: tt('在新标签页查看 {t} 的画面', { t: fmtTs(fr.t) }) }, h('img', { src: url, alt: tt('{t} 的画面', { t: fmtTs(fr.t) }), loading: 'lazy' }), h('span', { text: fmtTs(fr.t) })));
      }
      if (!list.length) grid.replaceWith(h('p', { class: 'hint', text: '找不到画面数据。' }));
    })
    .catch(() => grid.replaceWith(h('p', { class: 'notice err', text: '读取画面失败。' })));
  return wrap;
}

async function loadAudio(m, player, info) {
  try {
    const chunks = await getChunks(m.id);
    if (!chunks.length) {
      info.textContent = tt('找不到音频数据（可能已被清理或录音未写入）。');
      info.className = 'notice warn';
      return;
    }
    let expected = 0;
    let gap = false;
    for (const c of chunks) {
      if (c.startSample !== expected) gap = true;
      expected = c.startSample + c.sampleCount;
    }
    const blob = wavBlobAll(chunks);
    revokeAudio();
    audioUrl = URL.createObjectURL(blob);
    player.src = audioUrl;
    const secs = expected / SAMPLE_RATE;
    info.textContent = tt('时长 {d}（按实际录到的采样计算）', { d: fmtDuration(secs) }) + (gap ? tt(' · 检测到分块缺失，部分内容可能损坏') : '');
    if (gap) info.className = 'notice warn';
    player.addEventListener('error', () => {
      info.textContent = tt('浏览器无法播放这段音频（可能已损坏）。');
      info.className = 'notice warn';
    });
  } catch (e) {
    info.textContent = tt('读取音频失败。');
    info.className = 'notice err';
  }
}

function revokeAudio() {
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
}

async function exportRawSubtitle(m) {
  const raw = await getRaw(m.id, 'subtitle');
  if (!raw) return toast('没有原始字幕数据');
  downloadBlob(new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' }), `${safeFilename(m.title)}-${tt('原始字幕')}.json`);
}

// ---------------- 批量 ----------------

async function batchDelete() {
  const ids = [...checked];
  if (!ids.length) return;
  const prot = await sw('protected-ids');
  const busy = ids.filter((id) => (prot.ids || []).includes(id) || materials.find((m) => m.id === id)?.status === 'recording');
  if (busy.length) return toast(tt('所选材料中有 {n} 条正在录音或处理，请先停止或取消后再删除', { n: busy.length }), 6000);
  const titles = ids.map((id) => materials.find((m) => m.id === id)?.title || tt('未命名'));
  const body = h(
    'div',
    null,
    h('p', { text: tt('将永久删除以下 {n} 条材料及其音频、逐字稿、笔记和原始字幕。设置与 Key 不受影响。此操作无法撤销。', { n: ids.length }) }),
    h('ul', { class: 'hint' }, titles.slice(0, 6).map((x) => h('li', null, document.createTextNode(x))), titles.length > 6 ? h('li', { text: tt('…以及另外 {n} 条', { n: titles.length - 6 }) }) : null),
  );
  if (!(await confirmDialog({ title: tt('删除 {n} 条材料？', { n: ids.length }), body, ok: '永久删除', danger: true }))) return;
  try {
    await deleteMaterials(ids);
    checked.clear();
    toast(tt('已删除 {n} 条', { n: ids.length }));
  } catch (e) {
    toast('删除失败，所有材料均未改动');
  }
  reload();
}

function batchExport() {
  const ids = [...checked];
  const items = materials
    .filter((m) => ids.includes(m.id))
    .map((m) => ({
      id: m.id,
      title: m.title || '',
      platform: m.platform,
      createdAt: new Date(m.createdAt).toISOString(),
      source: m.source === 'subtitle' ? { type: 'subtitle', kind: m.subtitle && m.subtitle.kind, language: m.subtitle && m.subtitle.lan } : { type: 'audio', complete: !!(m.audio && m.audio.complete), endReason: m.audio && m.audio.endReason },
      transcript: m.transcript ? { kind: m.transcript.kind, text: m.transcript.effective, createdAt: new Date(m.transcript.createdAt).toISOString() } : null,
      notes: Object.fromEntries(Object.entries(m.notes || {}).map(([k, n]) => [k, { mode: NOTE_MODES[k] ? NOTE_MODES[k].label : k, markdown: n.markdown, createdAt: new Date(n.createdAt).toISOString(), possiblyStale: (n.transcriptVersion || 1) !== (m.transcriptVersion || 1) }])),
    }));
  const data = { app: 'WatchVid4U', format: 'text-export', version: 1, exportedAt: new Date().toISOString(), count: items.length, items };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `WatchVid4U-${tt('文字导出')}-${new Date().toISOString().slice(0, 10)}.json`);
}
