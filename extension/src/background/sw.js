// Service Worker：唯一的任务状态机与入口汇聚点（工具栏 / 浮窗 / 快捷键 走同一流程）。
import {
  loadSettings,
  sttTarget,
  llmTarget,
  getKey,
  hasOriginPermission,
  readiness,
  sliceSeconds,
  consentValid,
} from '../shared/settings.js';
import { AppError, toSafeError, describeError, messageFor } from '../shared/errors.js';
import { initLang, t as tr } from '../shared/i18n.js';
// 任务字段里的固定文案以中文原文保存，界面显示时再翻译；带数字的动态文案在这里按当前界面语言生成
initLang();
import { fetchBiliSubtitle, isAllowedBiliUrl, KIND_LABELS } from '../shared/bilibili.js';
import { detectPlatform, videoKeyFromUrl, isCapturableUrl } from '../shared/platform.js';
import { putMaterial, updateMaterial, getMaterial, putRaw, enforceAudioCache, listMaterials } from '../shared/db.js';
import { composeTranscript } from '../shared/transcript.js';
import { uid, platformLabel } from '../shared/format.js';
import { SAMPLE_RATE } from '../shared/wav.js';
import { NOTE_MODES } from '../shared/prompts.js';

const ACTIVE = new Set(['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'saving', 'transcribing', 'noting', 'needs_action']);
// 占用“录制名额”的阶段（转写/笔记阶段不再占用标签页，不计入同时录制上限）
const CAPTURE_PHASES = new Set(['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'saving', 'needs_action']);
const MAX_FINISHED = 10; // 保留最近结束的任务数（供弹窗查看结果）
const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

let tasks = {}; // taskId -> 任务（每个标签页同一时间最多一个进行中的任务）
let jobs = {}; // jobId -> {materialId, kind, taskId, fp, mode}
let sttQueue = []; // 待转写队列：[{materialId, taskId, at}]（转写依次进行，避免本地服务忙或云端限流）
const startingTabs = new Set(); // 同步锁：防止同一标签页双击/多入口竞态
let keepAliveTimer = null;
const ready = restore();

// ---------------- 持久化与广播 ----------------

async function restore() {
  const s = await chrome.storage.session.get(['tasks', 'task', 'jobs', 'sttQueue']);
  tasks = s.tasks || {};
  if (s.task && !tasks[s.task.id]) tasks[s.task.id] = s.task; // 旧版单任务数据
  jobs = s.jobs || {};
  sttQueue = s.sttQueue || [];
  const alive = await offscreenPing();
  for (const t of Object.values(tasks)) {
    if (!isActive(t)) continue;
    // SW 被回收后重启：确认 offscreen 是否仍在录音/处理
    if (t.phase === 'recording' && !(alive && (alive.recordingIds || []).includes(t.materialId))) {
      await interruptRecording(t, 'capture_failed', '后台录音进程已结束');
    } else if (t.phase === 'noting' && !(alive && alive.jobs)) {
      await failTask(t, new AppError('unknown', { stage: 'llm', detail: '后台处理进程已结束' }));
    } else if (t.phase === 'transcribing' && t.jobId && !(alive && alive.jobs)) {
      await failTask(t, new AppError('unknown', { stage: 'stt', detail: '后台处理进程已结束' }));
    } else if (['detecting', 'subtitle', 'preparing', 'waiting_ad'].includes(t.phase)) {
      await failTask(t, new AppError('unknown', { stage: 'detect', detail: '扩展后台被浏览器重启，请重新开始' }));
    }
  }
  for (const [id, j] of Object.entries(jobs)) {
    if (!(alive && alive.jobs)) {
      delete jobs[id];
      await updateMaterial(j.materialId, (m) => ((m.processing = null), m)).catch(() => {});
    }
  }
  await chrome.storage.session.remove('task');
  await persistJobs();
  await persistTasks();
  pumpStt();
}

/** 保存全部任务；传入 t 时同时通知该任务所在的标签页 */
async function persistTasks(t) {
  if (t) t.updatedAt = Date.now();
  pruneFinished();
  await chrome.storage.session.set({ tasks });
  updateBadge();
  if (t && t.tabId != null && tasks[t.id] === t) sendToTab(t.tabId, { type: 'task-update', task: clone(t) }).catch(() => {});
}

function pruneFinished() {
  const done = Object.values(tasks)
    .filter((t) => !isActive(t))
    .sort((a, b) => (b.finishedAt || b.updatedAt || 0) - (a.finishedAt || a.updatedAt || 0));
  for (const t of done.slice(MAX_FINISHED)) delete tasks[t.id];
}

async function persistJobs() {
  await chrome.storage.session.set({ jobs });
}

async function persistQueue() {
  await chrome.storage.session.set({ sttQueue });
}

function clone(x) {
  return x ? JSON.parse(JSON.stringify(x)) : null;
}

function isActive(t) {
  return !!(t && ACTIVE.has(t.phase));
}

/** 任务是否仍被跟踪（被关闭/替换后，进行中的流程应停止） */
function tracked(t) {
  return !!(t && tasks[t.id] === t);
}

function taskList() {
  return Object.values(tasks).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function activeTasks() {
  return taskList().filter(isActive);
}

function activeTaskForTab(tabId) {
  return activeTasks().find((t) => t.tabId === tabId) || null;
}

/** 某标签页的任务：优先进行中的，否则最近结束的 */
function taskForTab(tabId) {
  return activeTaskForTab(tabId) || taskList().find((t) => t.tabId === tabId) || null;
}

function taskByMaterial(materialId) {
  return activeTasks().find((t) => t.materialId === materialId) || null;
}

function captureCount() {
  const starting = [...startingTabs].filter((id) => !activeTaskForTab(id)).length;
  return activeTasks().filter((t) => CAPTURE_PHASES.has(t.phase)).length + starting;
}

/** 页面请求定位任务：taskId > tabId > 最近的进行中任务 > 最近的任务 */
function resolveTask(msg) {
  if (msg.taskId) return tasks[msg.taskId] || null;
  if (msg.tabId != null) return taskForTab(msg.tabId);
  return activeTasks()[0] || taskList()[0] || null;
}

function setPhase(t, phase, text) {
  t.phase = phase;
  t.phaseText = text || '';
}

function updateBadge() {
  const act = activeTasks();
  const rec = act.filter((t) => t.phase === 'recording').length;
  let text = '';
  let color = '#4263eb';
  if (rec) {
    text = rec > 1 ? `${rec}REC` : 'REC';
    color = '#e03131';
  } else if (act.some((t) => t.phase === 'needs_action')) {
    text = '!';
    color = '#f08c00';
  } else if (act.length) {
    text = '…';
  } else {
    const last = taskList()[0];
    if (last && (last.phase === 'failed' || last.phase === 'interrupted')) {
      text = '!';
      color = '#e03131';
    }
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function busyAnywhere() {
  return activeTasks().length > 0 || Object.keys(jobs).length > 0 || sttQueue.length > 0;
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (!busyAnywhere()) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

// ---------------- Offscreen ----------------

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: '录制你授权的标签页声音，并在后台把录音分片发送给你配置的转写/笔记服务。',
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function offscreen(type, payload = {}) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
  if (!r) throw new AppError('unknown', { detail: '后台处理进程无响应' });
  if (!r.ok) throw Object.assign(new AppError(r.error.code || 'unknown', { stage: r.error.stage, detail: r.error.detail, diag: r.error.diag }));
  return r;
}

async function offscreenPing() {
  if (!(await hasOffscreen())) return null;
  try {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
    return r && r.ok ? r : null;
  } catch {
    return null;
  }
}

async function maybeCloseOffscreen() {
  setTimeout(async () => {
    if (busyAnywhere()) return;
    const p = await offscreenPing();
    if (p && !(p.recordingIds || []).length && !p.jobs) chrome.offscreen.closeDocument().catch(() => {});
  }, 60000);
}

// ---------------- 标签页通信 ----------------

async function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, { target: 'content', ...msg }, { frameId: 0 });
}

async function ensureContent(tabId) {
  try {
    const r = await sendToTab(tabId, { type: 'ping' });
    if (r && r.ok) return r;
  } catch {
    /* 未注入 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['src/shared/i18n-en.js', 'src/shared/uiscale.js', 'src/content/detector.js', 'src/content/content.js'] });
  } catch (e) {
    throw new AppError('capture_not_invoked', { stage: 'detect', detail: '无法访问此页面；请在页面上点击工具栏图标后重试' });
  }
  const r = await sendToTab(tabId, { type: 'ping' });
  if (!r || !r.ok) throw new AppError('media_not_found', { stage: 'detect' });
  return r;
}

// ---------------- 任务主流程 ----------------

function newTask({ tab, mode, origin, probe }) {
  return {
    id: uid('t_'),
    tabId: tab.id,
    origin,
    platform: probe.platform,
    videoKey: probe.videoKey,
    title: probe.title || tab.title || '',
    url: tab.url,
    startMode: mode,
    phase: 'detecting',
    phaseText: '正在识别视频…',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    materialId: null,
    subtitle: { state: probe.platform === 'bilibili' ? 'pending' : 'skipped' },
    audio: { state: 'none', seconds: 0 },
    playback: { state: 'unknown' },
    stt: { state: 'none' },
    note: { state: 'none' },
    warnings: [],
    error: null,
    monitor: false,
    media: probe.media ? { duration: probe.media.duration, currentTime: probe.media.currentTime } : null,
    hasMedia: !!probe.media,
  };
}

async function startTask({ tabId, mode, origin }) {
  await ready;
  if (startingTabs.has(tabId)) return { ok: false, error: toSafeError(new AppError('task_busy', { detail: '正在启动中' })) };
  const existing = activeTaskForTab(tabId);
  if (existing && existing.phase === 'needs_action') return resumeCapture(existing);
  if (existing) return { ok: true, already: true, task: clone(existing) };
  startingTabs.add(tabId); // 先上锁再做任何异步操作
  let t;
  try {
    const settings = await loadSettings();
    const max = Math.max(1, Math.min(6, Math.round(settings.record.maxConcurrent) || 3));
    if (captureCount() - 1 >= max) throw new AppError('task_limit', { stage: 'capture', detail: tr('上限 {n} 个', { n: max }) });
    // 注意：仅靠内容脚本匹配，扩展无法读取 tab.url（需 activeTab 或显式主机权限），因此以内容脚本报告的地址为准
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && !isCapturableUrl(tab.url)) throw new AppError('media_not_found', { stage: 'detect', detail: '浏览器内置页面和扩展商店页面无法处理' });
    await ensureContent(tabId);
    const probe = await sendToTab(tabId, { type: 'probe' });
    if (!probe || !probe.ok) throw new AppError('media_not_found', { stage: 'detect' });
    if (!tab.url) tab.url = probe.url;
    t = newTask({ tab, mode, origin, probe });
    t.monitor = !!settings.record.monitor;
    // 同一标签页只保留最新的任务记录
    for (const old of Object.values(tasks)) if (old.tabId === tabId && !isActive(old)) delete tasks[old.id];
    tasks[t.id] = t;
    startKeepAlive();
    await persistTasks(t);
  } catch (e) {
    return { ok: false, error: toSafeError(e, 'detect') };
  } finally {
    startingTabs.delete(tabId);
  }
  runPipeline(t).catch((e) => failTask(t, e));
  return { ok: true, task: clone(t) };
}

async function runPipeline(t) {
  const settings = await loadSettings();
  if (t.platform === 'bilibili' && settings.subtitle.enabled) {
    setPhase(t, 'subtitle', '正在获取 B站完整字幕…');
    t.subtitle = { state: 'trying' };
    await persistTasks(t);
    try {
      const sub = await withTimeout(getBiliSubtitle(t, settings), settings.subtitle.timeoutSec * 1000, () => new AppError('sub_timeout', { stage: 'subtitle' }));
      if (!tracked(t) || !isActive(t)) return;
      await saveSubtitleMaterial(t, sub);
      return afterTranscript(t, settings);
    } catch (e) {
      if (!tracked(t) || !isActive(t)) return;
      const se = toSafeError(e, 'subtitle');
      t.subtitle = { state: 'failed', reason: se.message + (se.detail ? `（${se.detail}）` : ''), code: se.code };
      if (se.code === 'sub_identity_changed') return failTask(t, e);
      setPhase(t, 'preparing', '字幕不可用，已自动转为录音…');
      await persistTasks(t);
    }
  }
  return startRecording(t, settings);
}

function withTimeout(p, ms, mkErr) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(mkErr()), ms)))]).finally(() => clearTimeout(timer));
}

async function currentPage(tabId) {
  const r = await sendToTab(tabId, { type: 'probe' }).catch(() => null);
  if (!r || !r.ok) throw new AppError('target_lost', { stage: 'detect', detail: '页面已不可访问' });
  return r;
}

async function getBiliSubtitle(t, settings) {
  const page = await currentPage(t.tabId);
  const fetchJson = async (url) => {
    if (!isAllowedBiliUrl(url)) throw new AppError('sub_access', { stage: 'subtitle' });
    const r = await sendToTab(t.tabId, { type: 'bili-fetch', url, withLogin: !!settings.subtitle.useLogin });
    if (!r || !r.ok) throw new AppError('sub_access', { stage: 'subtitle', diag: r ? { status: r.status || 0 } : null });
    return r.json;
  };
  const checkIdentity = async () => {
    const cur = await currentPage(t.tabId);
    if (cur.videoKey !== t.videoKey) throw new AppError('sub_identity_changed', { stage: 'subtitle' });
  };
  if (page.videoKey !== t.videoKey) throw new AppError('sub_identity_changed', { stage: 'subtitle' });
  return fetchBiliSubtitle({ href: page.url, fetchJson, policy: settings.subtitle, checkIdentity });
}

async function saveSubtitleMaterial(t, sub) {
  const id = uid('m_');
  const transcript = composeTranscript({ plain: sub.text, speaker: null, source: 'subtitle', model: null, segments: null });
  transcript.version = 1;
  const material = {
    id,
    createdAt: Date.now(),
    title: sub.video.title + (sub.video.part && sub.video.part !== sub.video.title ? ` · P${sub.video.p} ${sub.video.part}` : ''),
    platform: 'bilibili',
    pageUrl: t.url,
    source: 'subtitle',
    subtitle: {
      lan: sub.track.lan,
      lanDoc: sub.track.lanDoc,
      kind: sub.track.kind,
      kindLabel: KIND_LABELS[sub.track.kind],
      lines: sub.lines.length,
      lastTo: sub.lastTo,
      video: { bvid: sub.video.bvid, aid: sub.video.aid, cid: sub.video.cid, p: sub.video.p, duration: sub.video.duration },
      available: sub.availableTracks,
      fetchedAt: Date.now(),
      usedLogin: !!(await loadSettings()).subtitle.useLogin,
    },
    audio: null,
    transcript,
    transcriptVersion: 1,
    notes: {},
    status: 'ready',
  };
  await putRaw(id, 'subtitle', { track: sub.track, video: sub.video, body: sub.raw });
  await putMaterial(material);
  t.materialId = id;
  t.title = material.title || t.title;
  t.subtitle = { state: 'ok', kind: sub.track.kind, kindLabel: KIND_LABELS[sub.track.kind], lanDoc: sub.track.lanDoc };
  t.stt = { state: 'skipped', reason: '已使用字幕，无需转写' };
  t.audio = { state: 'none' };
  t.playback = { state: 'not_applicable' };
  await persistTasks(t);
}

// ----- 录音 -----

async function startRecording(t, settings) {
  if (!tracked(t)) return;
  if (!t.hasMedia) {
    if (t.startMode === 'beginning') throw new AppError('media_not_found', { stage: 'detect', detail: '找不到可定位到开头的视频/音频' });
    t.warnings.push('页面上没有可控制的媒体元素：将录制标签页声音，需要你手动“停止并保存”。');
  }
  setPhase(t, 'preparing', t.startMode === 'beginning' ? '正在回到开头并准备录音…' : '正在准备录音…');
  await persistTasks(t);
  // 1) 网页准备：暂停、定位起点；YouTube 广告时等待正文
  if (t.hasMedia) {
    const prep = await sendToTab(t.tabId, { type: 'prepare', taskId: t.id, mode: t.startMode }).catch(() => null);
    if (!tracked(t) || !isActive(t)) return;
    if (!prep || !prep.ok) throw new AppError(prep && prep.code ? prep.code : 'media_not_found', { stage: 'playback', detail: prep && prep.detail });
    t.startOffsetSec = prep.startOffset;
    t.wasPaused = prep.wasPaused;
  }
  // 2) 获取录音授权流
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: t.tabId });
  } catch (e) {
    const msg = String(e && e.message);
    if (/invoked|activeTab/i.test(msg)) {
      setPhase(t, 'needs_action', messageFor('capture_not_invoked'));
      t.error = toSafeError(new AppError('capture_not_invoked', { stage: 'capture' }));
      await persistTasks(t);
      return;
    }
    if (/active stream/i.test(msg)) throw new AppError('capture_busy', { stage: 'capture' });
    throw new AppError('capture_failed', { stage: 'capture', detail: msg.slice(0, 100) });
  }
  return beginCapture(t, streamId);
}

async function resumeCapture(t) {
  if (!t || t.phase !== 'needs_action') return { ok: false };
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: t.tabId });
    t.error = null;
    beginCapture(t, streamId).catch((e) => failTask(t, e));
    return { ok: true, task: clone(t) };
  } catch (e) {
    return { ok: false, error: toSafeError(new AppError('capture_not_invoked', { stage: 'capture' })) };
  }
}

async function beginCapture(t, streamId) {
  const materialId = uid('m_');
  const material = {
    id: materialId,
    createdAt: Date.now(),
    title: t.title,
    platform: t.platform,
    pageUrl: t.url,
    source: 'audio',
    subtitleAttempt: t.subtitle.state === 'failed' ? { reason: t.subtitle.reason, code: t.subtitle.code } : null,
    audio: { sampleRate: SAMPLE_RATE, samples: 0, bytes: 0, chunks: 0, complete: false, endReason: null, startMode: t.startMode, startOffsetSec: t.startOffsetSec || 0, adIntervals: [] },
    transcript: null,
    notes: {},
    status: 'recording',
  };
  await putMaterial(material);
  t.materialId = materialId;
  await enforceAudioCache(protectedIds()).catch(() => {});
  const fs = (await loadSettings()).frames;
  const frames = fs.enabled ? { enabled: true, intervalSec: Math.max(5, Math.min(600, Math.round(fs.intervalSec) || 30)) } : null;
  await offscreen('rec-start', { streamId, materialId, monitor: t.monitor, frames }).catch(async (e) => {
    await updateMaterial(materialId, (m) => ((m.status = 'failed'), (m.lastError = toSafeError(e, 'capture')), m));
    throw e;
  });
  t.audio = { state: 'recording', seconds: 0 };
  setPhase(t, 'recording', '录音中');
  await persistTasks(t);
  if (t.hasMedia) {
    const r = await sendToTab(t.tabId, { type: 'arm-and-play', taskId: t.id }).catch(() => null);
    if (!tracked(t)) return;
    if (!r || !r.ok) {
      await interruptRecording(t, 'target_lost', '无法控制网页视频');
      return;
    }
    if (r.blocked) {
      t.warnings.push(messageFor('play_blocked'));
      t.playback = { state: 'blocked' };
    } else t.playback = { state: 'playing' };
    if (r.muted) t.warnings.push('网页视频处于静音或音量为 0，录到的将是静音；请在网页上打开声音。');
    await persistTasks(t);
  }
}

/** 录音结束（正常播完 / 手动 / 中断） */
async function finishRecording(t, reason, detail, tailOverride) {
  if (!t || t.audio.state !== 'recording') return;
  t.audio.state = 'stopping';
  setPhase(t, 'saving', '正在保存录音…');
  await persistTasks(t);
  let res = null;
  try {
    const tailMs = tailOverride != null ? tailOverride : reason === 'ended' ? 700 : reason === 'manual' ? 200 : 0;
    res = (await offscreen('rec-stop', { materialId: t.materialId, tailMs })).result;
  } catch (e) {
    res = null;
  }
  const complete = reason === 'ended' || reason === 'manual';
  const seconds = res ? res.samples / SAMPLE_RATE : 0;
  await updateMaterial(t.materialId, (m) => {
    m.status = complete ? 'ready' : 'incomplete';
    m.audio.complete = complete;
    m.audio.endReason = reason;
    m.audio.endDetail = detail || null;
    if (res) {
      m.audio.samples = res.samples;
      m.audio.bytes = res.bytes;
      m.audio.adIntervals = res.adIntervals || [];
      if (res.frames) m.frames = res.frames;
    }
    return m;
  });
  t.audio = { state: complete ? 'saved' : 'incomplete', seconds, endReason: reason, writeError: res && res.writeError };
  await enforceAudioCache(protectedIds()).catch(() => {});
  return { complete, seconds };
}

async function onMediaEnded(t, info) {
  if (!t || t.phase !== 'recording') return;
  t.playback = { state: info.paused ? 'guarded' : 'failed', detail: info.paused ? '已暂停并阻止自动续播' : '未能暂停网页播放' };
  // 正常结束：多收 0.7 s 尾音保住尾句；检测到播放器已自行从头循环：立即停止，不录入重播内容
  const r = await finishRecording(t, 'ended', null, info.kind === 'loop' ? 0 : 700);
  if (!r) return;
  // 稍后复核网页是否仍保持暂停（防延迟脚本重新播放）
  setTimeout(() => verifyGuard(t.id), 2500);
  const settings = await loadSettings();
  if (r.seconds < 1) return failTask(t, new AppError('empty_transcript', { stage: 'capture', detail: '录到的音频不足 1 秒' }));
  if (settings.record.autoTranscribe) return autoTranscribe(t, settings);
  return completeTask(t, '音频已保存（已关闭自动转写）');
}

async function verifyGuard(taskId) {
  const t = tasks[taskId];
  if (!t) return;
  const r = await sendToTab(t.tabId, { type: 'guard-status', taskId }).catch(() => null);
  if (!tracked(t)) return;
  if (r && r.ok) {
    if (r.state === 'guarded') t.playback = { state: 'guarded', detail: r.repauses ? tr('已暂停（拦截了 {n} 次自动播放）', { n: r.repauses }) : '已暂停并保持' };
    else if (r.state === 'released') t.playback = { state: 'released', detail: '你已主动继续播放，保护已解除' };
    else if (r.state === 'failed') t.playback = { state: 'failed', detail: '网页仍在播放，未能保持暂停' };
  }
  await persistTasks(t);
}

async function stopTask(t) {
  await ready;
  if (!t || !isActive(t)) return { ok: false };
  if (t.phase === 'recording') {
    const settings = await loadSettings();
    if (settings.record.pauseOnStop && t.hasMedia) {
      const r = await sendToTab(t.tabId, { type: 'pause-for-stop', taskId: t.id }).catch(() => null);
      t.playback = r && r.ok ? { state: 'paused', detail: '已随停止暂停' } : { state: 'failed', detail: '未能暂停网页' };
    } else sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
    const r = await finishRecording(t, 'manual');
    if (!r) return { ok: true };
    if (r.seconds < 1) {
      failTask(t, new AppError('empty_transcript', { stage: 'capture', detail: '录到的音频不足 1 秒' }));
      return { ok: true };
    }
    if (settings.record.transcribeAfterManualStop) autoTranscribe(t, settings);
    else completeTask(t, '音频已保存（手动停止，未自动转写）');
    return { ok: true };
  }
  return cancelTask(t);
}

async function cancelTask(t) {
  if (!t || !isActive(t)) return { ok: false };
  if (t.phase === 'recording') {
    sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
    await finishRecording(t, 'cancelled');
    setPhase(t, 'cancelled', '已取消；已录部分保存为不完整音频');
  } else if (t.phase === 'transcribing' || t.phase === 'noting') {
    if (t.jobId) await cancelJob(t.jobId, '已取消');
    else await dequeueStt(t.materialId);
    setPhase(t, 'cancelled', '已取消后续处理；已保存的音频和文字保留');
  } else {
    sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
    setPhase(t, 'cancelled', '已取消');
  }
  t.finishedAt = Date.now();
  await persistTasks(t);
  maybeCloseOffscreen();
  return { ok: true };
}

async function interruptRecording(t, code, detail) {
  if (!t) return;
  if (t.phase === 'recording') {
    const r = await finishRecording(t, 'interrupted', messageFor(code));
    t.error = toSafeError(new AppError(code, { stage: 'capture', detail }));
    setPhase(t, 'interrupted', r && r.seconds > 0 ? tr('录音中断，已保留 {n} 秒（不完整，未自动转写）', { n: Math.round(r.seconds) }) : '录音中断');
    t.finishedAt = Date.now();
    await persistTasks(t);
    notify(t, '录音中断', describeError(t.error));
    maybeCloseOffscreen();
  } else if (isActive(t) && ['detecting', 'subtitle', 'preparing', 'waiting_ad', 'needs_action'].includes(t.phase)) {
    await failTask(t, new AppError(code, { stage: 'detect', detail }));
  }
}

// ----- 转写与笔记 -----

async function sttConfig(settings) {
  const target = sttTarget(settings);
  // 云端必须有 Key；本地服务的 Key 可选，填了就带上
  const key = await getKey(target.keyService, target.endpoint);
  const perm = await hasOriginPermission(target.endpoint);
  const rd = readiness(target, key, perm);
  if (!rd.ok) return { ok: false, code: rd.code };
  const local = target.service === 'local';
  return {
    ok: true,
    fp: fingerprint(target),
    cfg: {
      service: target.service,
      endpoint: target.endpoint,
      key,
      model: local ? settings.local.model : settings.stt.model,
      language: settings.stt.language,
      prompt: settings.stt.prompt,
      responseFormat: local ? 'verbose_json' : settings.stt.responseFormat,
      sliceSec: sliceSeconds(local ? settings.local.maxUploadMB : settings.stt.maxUploadMB, settings.stt.maxSliceMin),
      maxUploadBytes: (local ? settings.local.maxUploadMB : settings.stt.maxUploadMB) * 1024 * 1024,
      timeoutMs: (local ? settings.local.timeoutSec : settings.stt.timeoutSec) * 1000,
      filterLowConfidence: settings.stt.filterLowConfidence,
      diarize: local && settings.local.diarize,
    },
  };
}

async function llmConfig(settings) {
  const target = llmTarget(settings);
  const key = await getKey('llm', target.endpoint);
  const perm = await hasOriginPermission(target.endpoint);
  const rd = readiness(target, key, perm);
  if (!rd.ok) return { ok: false, code: rd.code };
  if (!settings.llm.model) return { ok: false, code: 'not_configured' };
  return {
    ok: true,
    fp: fingerprint(target),
    cfg: {
      endpoint: target.endpoint,
      key,
      model: settings.llm.model,
      maxInputChars: settings.llm.maxInputChars,
      maxTokens: settings.llm.maxOutputTokens,
      temperature: settings.llm.temperature,
      timeoutMs: settings.llm.timeoutSec * 1000,
      ignorePromo: settings.note.ignorePromo,
      // 附带画面：需用户为当前笔记服务单独确认过“发送画面”
      maxFrames: settings.llm.sendFrames && consentValid(settings.consent.frames, target.endpoint) ? Math.max(1, Math.min(50, Math.round(settings.llm.maxFrames) || 20)) : 0,
    },
  };
}

function fingerprint(target) {
  return `${target.service}|${target.endpoint}|${target.model}|${target.consent ? target.consent.grantedAt : 0}`;
}

async function autoTranscribe(t, settings) {
  const c = await sttConfig(settings);
  if (!c.ok) {
    t.stt = { state: 'skipped', reason: messageFor(c.code) };
    return completeTask(t, tr('音频已保存；未自动转写：{why}', { why: tr(messageFor(c.code)) }));
  }
  setPhase(t, 'transcribing', '正在转写…');
  t.stt = { state: 'queued' };
  await persistTasks(t);
  await enqueueStt(t.materialId, t.id);
}

// ----- 转写队列：一次只转写一条，其余排队 -----

function sttRunning() {
  return Object.values(jobs).some((j) => j.kind === 'stt');
}

async function enqueueStt(materialId, taskId = null) {
  sttQueue.push({ materialId, taskId, at: Date.now() });
  await updateMaterial(materialId, (m) => ((m.processing = { kind: 'stt', queued: true, startedAt: Date.now() }), m)).catch(() => {});
  await persistQueue();
  startKeepAlive();
  await refreshQueueText();
  pumpStt();
}

async function dequeueStt(materialId) {
  const before = sttQueue.length;
  sttQueue = sttQueue.filter((q) => q.materialId !== materialId);
  if (sttQueue.length === before) return false;
  await persistQueue();
  await updateMaterial(materialId, (m) => ((m.processing = null), m)).catch(() => {});
  await refreshQueueText();
  return true;
}

/** 更新排队中任务的提示（前面还有几条） */
async function refreshQueueText() {
  const running = sttRunning() ? 1 : 0;
  for (let i = 0; i < sttQueue.length; i++) {
    const t = sttQueue[i].taskId ? tasks[sttQueue[i].taskId] : null;
    if (!t || t.phase !== 'transcribing' || t.jobId) continue;
    const ahead = i + running;
    t.stt = { state: 'queued', ahead };
    t.phaseText = ahead ? tr('排队等待转写（前面还有 {n} 条）…', { n: ahead }) : '即将开始转写…';
    await persistTasks(t);
  }
}

let pumping = false;
async function pumpStt() {
  if (pumping) return;
  pumping = true;
  try {
    while (!sttRunning() && sttQueue.length) {
      const q = sttQueue.shift();
      await persistQueue();
      const t = q.taskId ? tasks[q.taskId] : null;
      if (q.taskId && (!t || t.phase !== 'transcribing')) {
        await updateMaterial(q.materialId, (m) => ((m.processing = null), m)).catch(() => {});
        continue;
      }
      const settings = await loadSettings();
      const c = await sttConfig(settings);
      if (!c.ok) {
        const err = toSafeError(new AppError(c.code, { stage: 'stt' }));
        await updateMaterial(q.materialId, (m) => ((m.processing = null), (m.lastError = { ...err, at: Date.now(), kind: 'stt' }), m)).catch(() => {});
        if (t) {
          t.stt = { state: 'skipped', reason: messageFor(c.code) };
          await completeTask(t, tr('音频已保存；未转写：{why}', { why: tr(messageFor(c.code)) }));
        }
        continue;
      }
      if (t) {
        t.stt = { state: 'running', done: 0, total: 0 };
        t.phaseText = '正在转写…';
      }
      const jobId = await startJob({ kind: 'stt', materialId: q.materialId, cfg: c.cfg, fp: c.fp, taskId: q.taskId });
      if (t && jobs[jobId]) {
        t.jobId = jobId;
        await persistTasks(t);
      }
      await refreshQueueText();
    }
  } finally {
    pumping = false;
  }
}

async function afterTranscript(t, settings) {
  if (!tracked(t)) return;
  settings = settings || (await loadSettings());
  if (settings.note.auto) {
    const c = await llmConfig(settings);
    if (!c.ok) {
      t.note = { state: 'skipped', reason: messageFor(c.code) };
      return completeTask(t, tr('逐字稿已保存；未自动生成笔记：{why}', { why: tr(messageFor(c.code)) }));
    }
    setPhase(t, 'noting', tr('正在生成{mode}笔记…', { mode: tr(NOTE_MODES[settings.note.mode].label) }));
    t.note = { state: 'running', mode: settings.note.mode };
    await persistTasks(t);
    t.jobId = await startJob({ kind: 'llm', materialId: t.materialId, cfg: c.cfg, fp: c.fp, taskId: t.id, mode: settings.note.mode });
    await persistTasks(t);
    return;
  }
  return completeTask(t, t.subtitle.state === 'ok' ? '已保存字幕逐字稿' : '逐字稿已保存');
}

async function startJob({ kind, materialId, cfg, fp, taskId = null, mode = null }) {
  const jobId = uid('j_');
  jobs[jobId] = { kind, materialId, taskId, fp, mode, startedAt: Date.now() };
  await persistJobs();
  startKeepAlive();
  await updateMaterial(materialId, (m) => ((m.processing = { kind, jobId, mode, startedAt: Date.now() }), m));
  try {
    const r = await offscreen(kind === 'stt' ? 'job-transcribe' : 'job-note', { jobId, materialId, cfg, mode });
    if (!r.started) throw new AppError('unknown', { detail: '任务未能启动' });
  } catch (e) {
    await onJobFinished({ jobId, ok: false, error: toSafeError(e, kind) });
  }
  return jobId;
}

async function cancelJob(jobId, why) {
  const j = jobs[jobId];
  if (!j) return;
  j.cancelReason = why;
  await persistJobs();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'job-cancel', jobId }).catch(() => {});
}

async function onJobFinished({ jobId, ok, result, error }) {
  const j = jobs[jobId];
  if (!j) return; // 迟到或重复事件
  delete jobs[jobId];
  await persistJobs();
  const err = !ok ? (j.cancelReason && error && error.code === 'cancelled' ? { ...error, detail: j.cancelReason } : error) : null;
  await updateMaterial(j.materialId, (m) => {
    m.processing = null;
    if (err) m.lastError = { ...err, at: Date.now(), kind: j.kind };
    return m;
  }).catch(() => {});
  const t = j.taskId ? tasks[j.taskId] : null;
  if (t && t.jobId === jobId) {
    t.jobId = null;
    if (j.kind === 'stt') {
      if (ok) {
        t.stt = { state: 'done', chars: result.chars, kind: result.kind };
        await persistTasks(t);
        afterTranscript(t).catch((e) => failTask(t, e));
      } else if (t.phase !== 'cancelled') {
        t.stt = { state: 'failed', reason: describeError(err) };
        await failTask(t, err);
      }
    } else {
      if (ok) {
        t.note = { state: 'done', mode: j.mode };
        await completeTask(t, '逐字稿与笔记已保存');
      } else if (t.phase !== 'cancelled') {
        t.note = { state: 'failed', mode: j.mode, reason: describeError(err) };
        t.error = err;
        await completeTask(t, '逐字稿已保存；笔记生成失败（可在材料页重试）', true);
      }
    }
  }
  if (j.kind === 'stt') pumpStt();
  maybeCloseOffscreen();
}

async function completeTask(t, text, withProblem = false) {
  if (!t) return;
  setPhase(t, 'done', text);
  t.finishedAt = Date.now();
  await persistTasks(t);
  notify(t, withProblem ? '已完成（部分失败）' : '已完成', text);
  maybeCloseOffscreen();
}

async function failTask(t, e) {
  if (!t) return;
  const se = toSafeError(e);
  if (t.phase === 'recording') {
    await finishRecording(t, 'interrupted', se.message);
  }
  t.error = se;
  setPhase(t, 'failed', describeError(se));
  t.finishedAt = Date.now();
  if (t.hasMedia && t.tabId != null && t.audio.state !== 'saved') sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
  await persistTasks(t);
  notify(t, '处理失败', describeError(se));
  maybeCloseOffscreen();
}

async function notify(t, title, message) {
  const s = await loadSettings();
  if (!s.notify.enabled) return;
  chrome.notifications
    .create(`wv4u:${t.materialId || t.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: `WatchVid4U · ${tr(title)}`,
      message: `${t.title ? t.title.slice(0, 40) + (tr('：')) : ''}${tr(message)}`.slice(0, 180),
      priority: 0,
    })
    .catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('wv4u:')) return;
  const mid = id.slice(5);
  openLibrary(mid.startsWith('m_') ? mid : null);
  chrome.notifications.clear(id);
});

function openLibrary(materialId) {
  const url = chrome.runtime.getURL('src/ui/library.html') + (materialId ? `#${materialId}` : '');
  chrome.tabs.create({ url });
}

// ---------------- 材料页发起的处理 ----------------

async function materialTranscribe(materialId) {
  const m = await getMaterial(materialId);
  if (!m) return { ok: false, error: toSafeError(new AppError('db', { detail: '材料不存在' })) };
  if (m.processing) return { ok: false, error: toSafeError(new AppError('task_busy', { detail: '该材料正在处理' })) };
  if (m.status === 'recording') return { ok: false, error: toSafeError(new AppError('task_busy', { detail: '仍在录音' })) };
  const settings = await loadSettings();
  const c = await sttConfig(settings);
  if (!c.ok) return { ok: false, error: toSafeError(new AppError(c.code, { stage: 'stt' })) };
  const queued = sttRunning() || sttQueue.length > 0;
  await enqueueStt(materialId);
  return { ok: true, queued };
}

async function materialNote(materialId, mode) {
  const m = await getMaterial(materialId);
  if (!m) return { ok: false, error: toSafeError(new AppError('db', { detail: '材料不存在' })) };
  if (m.processing) return { ok: false, error: toSafeError(new AppError('task_busy', { detail: '该材料正在处理' })) };
  if (!m.transcript) return { ok: false, error: toSafeError(new AppError('transcript_missing', { stage: 'llm' })) };
  const settings = await loadSettings();
  const c = await llmConfig(settings);
  if (!c.ok) return { ok: false, error: toSafeError(new AppError(c.code, { stage: 'llm' })) };
  const jobId = await startJob({ kind: 'llm', materialId, cfg: c.cfg, fp: c.fp, mode: NOTE_MODES[mode] ? mode : 'concise' });
  return { ok: true, jobId };
}

async function materialCancel(materialId) {
  await dequeueStt(materialId);
  for (const [id, j] of Object.entries(jobs)) if (j.materialId === materialId) await cancelJob(id, '已取消');
  return { ok: true };
}

// 设置/Key/授权变化：停止受影响的进行中处理，不继续隐式发送
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (!Object.keys(jobs).length) return;
  const settingsChanged = area === 'local' && changes.settings;
  const sttKey = area === 'session' && (changes['secretRev.stt'] || changes['secretRev.local']);
  const llmKey = area === 'session' && changes['secretRev.llm'];
  if (!settingsChanged && !sttKey && !llmKey) return;
  const s = await loadSettings();
  const fpStt = fingerprint(sttTarget(s));
  const fpLlm = fingerprint(llmTarget(s));
  for (const [id, j] of Object.entries(jobs)) {
    const changed = j.kind === 'stt' ? sttKey || j.fp !== fpStt : llmKey || j.fp !== fpLlm;
    if (changed && !j.cancelReason) await cancelJob(id, '服务配置、Key 或授权已变更，已停止后续发送');
  }
});

// ---------------- 事件来源 ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') return false;
  if (sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  const fromContent = !fromExtensionPage && !!sender.tab;
  ready
    .then(() => route(msg, sender, { fromExtensionPage, fromContent }))
    .then((r) => sendResponse(r || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: toSafeError(e) }));
  return true;
});

async function route(msg, sender, { fromExtensionPage, fromContent }) {
  // offscreen 事件（扩展自身的非页面上下文；offscreen 的 sender.url 为扩展 URL）
  if (fromExtensionPage && sender.url.includes(OFFSCREEN_URL)) return offscreenEvent(msg);
  if (fromExtensionPage) return pageRequest(msg);
  if (fromContent) return contentEvent(msg, sender.tab);
  return { ok: false };
}

async function offscreenEvent(msg) {
  switch (msg.type) {
    case 'rec-level': {
      const t = taskByMaterial(msg.materialId);
      if (t && t.phase === 'recording') {
        t.audio.seconds = msg.seconds;
        const warn = msg.silentSec >= 15 && !t.paused;
        if (warn !== !!t.silenceWarn) {
          t.silenceWarn = warn;
          if (warn) t.warnings = [...t.warnings.filter((w) => !w.startsWith('检测到')), '检测到持续静音：请确认视频在播放且网页没有静音。'];
          else t.warnings = t.warnings.filter((w) => !w.startsWith('检测到'));
        }
        await persistTasks(t);
      }
      return { ok: true };
    }
    case 'rec-track-ended': {
      const t = taskByMaterial(msg.materialId);
      if (t && t.phase === 'recording') await interruptRecording(t, 'capture_failed', '浏览器结束了标签页录制');
      return { ok: true };
    }
    case 'rec-write-error': {
      const t = taskByMaterial(msg.materialId);
      if (t && t.phase === 'recording') await interruptRecording(t, msg.code === 'quota' ? 'quota' : 'db', '录音写入本地失败');
      return { ok: true };
    }
    case 'job-progress': {
      const j = jobs[msg.jobId];
      const t = j && j.taskId ? tasks[j.taskId] : null;
      if (t && t.jobId === msg.jobId) {
        t.stt = { state: 'running', done: msg.done, total: msg.total };
        t.phaseText = msg.total > 1 ? tr('正在转写（{done}/{total} 片）…', msg) : '正在转写…';
        await persistTasks(t);
      }
      await updateMaterial(msg.materialId, (m) => (m.processing ? ((m.processing.progress = { done: msg.done, total: msg.total }), m) : null)).catch(() => {});
      return { ok: true };
    }
    case 'job-finished':
      await onJobFinished(msg);
      return { ok: true };
    case 'offscreen-heartbeat':
      return { ok: true };
  }
  return { ok: false };
}

async function pageRequest(msg) {
  switch (msg.type) {
    case 'get-state': {
      const s = await loadSettings();
      return { ok: true, tasks: taskList().map(clone), task: clone(resolveTask(msg)), jobs, queue: sttQueue.length, maxConcurrent: Math.max(1, Math.min(6, Math.round(s.record.maxConcurrent) || 3)), capturing: captureCount() };
    }
    case 'start':
      return startTask({ tabId: msg.tabId, mode: msg.mode === 'beginning' ? 'beginning' : 'current', origin: 'popup' });
    case 'stop':
      return stopTask(resolveActive(msg));
    case 'cancel':
      return cancelTask(resolveActive(msg));
    case 'resume-capture':
      return resumeCapture(resolveActive(msg));
    case 'set-monitor':
      return setMonitor(resolveActive(msg), !!msg.on);
    case 'toggle-float':
      return toggleFloat(msg.tabId, msg.show);
    case 'probe-tab':
      return probeTab(msg.tabId);
    case 'material-transcribe':
      return materialTranscribe(msg.materialId);
    case 'material-note':
      return materialNote(msg.materialId, msg.mode);
    case 'material-cancel':
      return materialCancel(msg.materialId);
    case 'open-library':
      openLibrary(msg.materialId || null);
      return { ok: true };
    case 'dismiss-task': {
      // 指定 taskId 时只关闭该结果；否则关闭全部已结束的结果
      const list = msg.taskId ? [tasks[msg.taskId]].filter(Boolean) : Object.values(tasks);
      for (const t of list) if (!isActive(t)) delete tasks[t.id];
      await persistTasks();
      return { ok: true };
    }
    case 'protected-ids':
      return { ok: true, ids: protectedIds() };
  }
  return { ok: false };
}

/** 停止/取消类操作只针对进行中的任务 */
function resolveActive(msg) {
  if (msg.taskId) return tasks[msg.taskId] || null;
  if (msg.tabId != null) return activeTaskForTab(msg.tabId);
  return activeTasks()[0] || null;
}

function protectedIds() {
  const ids = Object.values(jobs).map((j) => j.materialId);
  for (const q of sttQueue) ids.push(q.materialId);
  for (const t of activeTasks()) if (t.materialId) ids.push(t.materialId);
  return ids;
}

async function setMonitor(t, on) {
  const s = await loadSettings();
  s.record.monitor = on; // 记住偏好，作为新任务的默认值
  await chrome.storage.local.set({ settings: s });
  if (t) {
    t.monitor = on;
    if (t.phase === 'recording') await offscreen('rec-monitor', { materialId: t.materialId, on }).catch(() => {});
    await persistTasks(t);
  }
  return { ok: true };
}

async function probeTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false };
  const platform = detectPlatform(tab.url || '');
  let info = null;
  try {
    const r = await sendToTab(tabId, { type: 'probe' });
    if (r && r.ok) info = r;
  } catch {
    /* 普通网页尚未注入：开始时再注入 */
  }
  const url = tab.url || (info && info.url) || '';
  return { ok: true, platform: info ? info.platform : platform, title: info ? info.title : tab.title, media: info ? info.media : null, injected: !!info, capturable: info ? true : isCapturableUrl(url), videoKey: info ? info.videoKey : videoKeyFromUrl(url) };
}

async function toggleFloat(tabId, show) {
  try {
    await ensureContent(tabId);
    return await sendToTab(tabId, { type: 'float-toggle', show });
  } catch (e) {
    return { ok: false, error: toSafeError(e) };
  }
}

async function contentEvent(msg, tab) {
  switch (msg.type) {
    case 'float-action': {
      const mine = activeTaskForTab(tab.id);
      if (msg.action === 'start' || msg.action === 'start-beginning') return startTask({ tabId: tab.id, mode: msg.action === 'start-beginning' ? 'beginning' : 'current', origin: 'float' });
      if (msg.action === 'stop') return mine ? stopTask(mine) : { ok: false, error: toSafeError(new AppError('task_busy', { detail: '本页没有进行中的任务' })) };
      if (msg.action === 'cancel') return mine ? cancelTask(mine) : { ok: false };
      if (msg.action === 'monitor') return setMonitor(mine, !!msg.on);
      if (msg.action === 'open-library') {
        const t = taskForTab(tab.id);
        openLibrary(t && t.materialId);
        return { ok: true };
      }
      if (msg.action === 'open-options') {
        chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      return { ok: false };
    }
    case 'get-task': {
      const t = taskForTab(tab.id);
      return { ok: true, task: clone(t), here: !!t };
    }
    case 'media-event': {
      const t = msg.taskId ? tasks[msg.taskId] : activeTaskForTab(tab.id);
      if (!t || t.tabId !== tab.id) return { ok: false };
      return mediaEvent(t, msg);
    }
    case 'diag':
      return storeDiag(msg.entry);
  }
  return { ok: false };
}

async function mediaEvent(t, msg) {
  switch (msg.event) {
    case 'waiting-ad':
      if (t.phase === 'preparing') {
        setPhase(t, 'waiting_ad', '正在等待广告结束，确认正文起点…（可取消）');
        await persistTasks(t);
      }
      break;
    case 'ad-done':
      if (t.phase === 'waiting_ad') {
        setPhase(t, 'preparing', '广告已结束，正在准备录音…');
        await persistTasks(t);
      }
      break;
    case 'ad':
      if (t.phase === 'recording') {
        offscreen('rec-ad', { materialId: t.materialId, ad: !!msg.ad }).catch(() => {});
        t.adNow = !!msg.ad;
        await persistTasks(t);
      }
      break;
    case 'paused':
      if (t.phase === 'recording') {
        t.paused = true;
        offscreen('rec-gate', { materialId: t.materialId, paused: true }).catch(() => {});
        t.phaseText = '视频已暂停，录音同步暂停';
        await persistTasks(t);
      }
      break;
    case 'playing':
      if (t.phase === 'recording') {
        t.paused = false;
        offscreen('rec-gate', { materialId: t.materialId, paused: false }).catch(() => {});
        t.phaseText = '录音中';
        if (t.playback.state === 'blocked') {
          t.playback = { state: 'playing' };
          t.warnings = t.warnings.filter((w) => w !== messageFor('play_blocked'));
        }
        await persistTasks(t);
      }
      break;
    case 'progress':
      if (t.phase === 'recording') {
        t.media = { currentTime: msg.currentTime, duration: msg.duration };
        await chrome.storage.session.set({ tasks });
      }
      break;
    case 'ended':
      await onMediaEnded(t, msg);
      break;
    case 'unknown-end':
      if (t.phase === 'recording' && !t.warnings.includes(msg.text)) {
        t.warnings.push(msg.text);
        await persistTasks(t);
      }
      break;
    case 'target-lost':
      if (t.phase === 'recording') await interruptRecording(t, msg.code || 'target_lost', msg.detail);
      else if (isActive(t) && t.phase !== 'transcribing' && t.phase !== 'noting' && t.phase !== 'saving') await failTask(t, new AppError(msg.code || 'target_lost', { stage: 'playback', detail: msg.detail }));
      break;
    case 'guard':
      if (t.id === msg.taskId && !isActive(t)) {
        if (msg.state === 'released') t.playback = { state: 'released', detail: '你已主动继续播放，保护已解除' };
        else if (msg.state === 'repaused') t.playback = { state: 'guarded', detail: tr('已暂停（拦截了 {n} 次自动播放）', { n: msg.count }) };
        else if (msg.state === 'failed') t.playback = { state: 'failed', detail: msg.detail || '未能保持暂停' };
        await persistTasks(t);
      } else if (t.id === msg.taskId && msg.state === 'repaused') {
        t.playback = { state: 'guarded', detail: tr('已暂停（拦截了 {n} 次自动播放）', { n: msg.count }) };
      }
      break;
  }
  return { ok: true };
}

async function storeDiag(entry) {
  const s = await loadSettings();
  if (!s.diag.youtube || !entry) return { ok: false };
  const safe = {
    t: Date.now(),
    state: String(entry.state || '').slice(0, 20),
    event: String(entry.event || '').slice(0, 40),
    reason: String(entry.reason || '').slice(0, 80),
    ct: Number.isFinite(entry.ct) ? Math.round(entry.ct * 10) / 10 : null,
    dur: Number.isFinite(entry.dur) ? Math.round(entry.dur * 10) / 10 : null,
  };
  const r = await chrome.storage.local.get('diag.youtube');
  const list = r['diag.youtube'] || [];
  list.push(safe);
  while (list.length > 300) list.shift();
  await chrome.storage.local.set({ 'diag.youtube': list });
  return { ok: true };
}

// 快捷键
chrome.commands.onCommand.addListener(async (command, tab) => {
  await ready;
  const activeTab = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!activeTab) return;
  if (command === 'start-current' || command === 'start-beginning') {
    const r = await startTask({ tabId: activeTab.id, mode: command === 'start-beginning' ? 'beginning' : 'current', origin: 'command' });
    if (!r.ok && r.error) showInPageToast(activeTab.id, describeError(r.error));
  } else if (command === 'stop-save') {
    // 优先停止当前标签页的任务；当前页没有时，若只有一个录制中的任务则停止它
    const mine = activeTaskForTab(activeTab.id);
    const capturing = activeTasks().filter((t) => CAPTURE_PHASES.has(t.phase));
    const target = mine || (capturing.length === 1 ? capturing[0] : null);
    if (target) await stopTask(target);
    else if (capturing.length > 1) showInPageToast(activeTab.id, tr('有多个任务在录制：请到对应页面或在工具栏弹窗中停止'));
  } else if (command === 'toggle-float') {
    await toggleFloat(activeTab.id);
  }
});

function showInPageToast(tabId, text) {
  sendToTab(tabId, { type: 'toast', text }).catch(() => {});
}

// 标签页生命周期
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const t = activeTaskForTab(tabId);
  if (t) {
    if (t.phase === 'recording') await interruptRecording(t, 'tab_closed');
    else if (['detecting', 'subtitle', 'preparing', 'waiting_ad', 'needs_action'].includes(t.phase)) await failTask(t, new AppError('tab_closed', { stage: 'detect' }));
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await ready;
  const t = activeTaskForTab(tabId);
  if (!t) return;
  if (!['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'needs_action'].includes(t.phase)) return;
  if (info.url) {
    const key = videoKeyFromUrl(info.url);
    if (t.videoKey && key && key !== t.videoKey) {
      if (t.phase === 'recording') await interruptRecording(t, 'navigated', '页面切换到了其他视频');
      else await failTask(t, new AppError('navigated', { stage: 'detect' }));
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启：上次未结束的录音标为不完整；清除过期处理标记。不自动补发旧任务。
  const all = await listMaterials().catch(() => []);
  for (const m of all) {
    if (m.status === 'recording' || m.processing) {
      await updateMaterial(m.id, (x) => {
        if (x.status === 'recording') {
          x.status = 'incomplete';
          if (x.audio) {
            x.audio.complete = false;
            x.audio.endReason = 'interrupted';
            x.audio.endDetail = '浏览器关闭或重启';
          }
        }
        x.processing = null;
        return x;
      });
    }
  }
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#welcome') });
});
