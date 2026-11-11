// Service Worker：唯一的任务状态机与入口汇聚点（工具栏 / 浮窗 / 快捷键 走同一流程）。
import {
  loadSettings,
  sttTarget,
  llmTarget,
  getKey,
  hasOriginPermission,
  readiness,
  sliceSeconds,
} from '../shared/settings.js';
import { AppError, toSafeError, describeError, messageFor } from '../shared/errors.js';
import { fetchBiliSubtitle, isAllowedBiliUrl, KIND_LABELS } from '../shared/bilibili.js';
import { detectPlatform, videoKeyFromUrl, isCapturableUrl } from '../shared/platform.js';
import { putMaterial, updateMaterial, getMaterial, putRaw, enforceAudioCache, listMaterials } from '../shared/db.js';
import { composeTranscript } from '../shared/transcript.js';
import { uid, platformLabel } from '../shared/format.js';
import { SAMPLE_RATE } from '../shared/wav.js';
import { NOTE_MODES } from '../shared/prompts.js';

const ACTIVE = new Set(['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'saving', 'transcribing', 'noting', 'needs_action']);
const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

let task = null; // 当前或最近一次视频任务
let jobs = {}; // jobId -> {materialId, kind, taskId, fp, mode}
let starting = false; // 同步锁：防止双击/多入口竞态
let keepAliveTimer = null;
const ready = restore();

// ---------------- 持久化与广播 ----------------

async function restore() {
  const s = await chrome.storage.session.get(['task', 'jobs']);
  task = s.task || null;
  jobs = s.jobs || {};
  if (task && ACTIVE.has(task.phase)) {
    // SW 被回收后重启：确认 offscreen 是否仍在录音/处理
    const alive = await offscreenPing();
    if (task.phase === 'recording' && !(alive && alive.recording)) {
      await interruptRecording('capture_failed', '后台录音进程已结束');
    } else if (['transcribing', 'noting'].includes(task.phase) && !(alive && alive.jobs)) {
      await failTask(new AppError('unknown', { stage: task.phase === 'noting' ? 'llm' : 'stt', detail: '后台处理进程已结束' }));
    } else if (['detecting', 'subtitle', 'preparing', 'waiting_ad'].includes(task.phase)) {
      await failTask(new AppError('unknown', { stage: 'detect', detail: '扩展后台被浏览器重启，请重新开始' }));
    }
  }
  for (const [id, j] of Object.entries(jobs)) {
    if (!(await offscreenPing())?.jobs) {
      delete jobs[id];
      await updateMaterial(j.materialId, (m) => ((m.processing = null), m)).catch(() => {});
    }
  }
  await persistJobs();
  updateBadge();
}

async function persistTask() {
  if (task) task.updatedAt = Date.now();
  await chrome.storage.session.set({ task });
  updateBadge();
  if (task && task.tabId != null) sendToTab(task.tabId, { type: 'task-update', task: publicTask() }).catch(() => {});
}

async function persistJobs() {
  await chrome.storage.session.set({ jobs });
}

function publicTask() {
  return task ? JSON.parse(JSON.stringify(task)) : null;
}

function isActive() {
  return !!(task && ACTIVE.has(task.phase));
}

function setPhase(phase, text) {
  task.phase = phase;
  task.phaseText = text || '';
}

function updateBadge() {
  let text = '';
  let color = '#4263eb';
  if (task) {
    if (task.phase === 'recording') {
      text = 'REC';
      color = '#e03131';
    } else if (['transcribing', 'noting', 'saving', 'subtitle', 'preparing', 'detecting', 'waiting_ad'].includes(task.phase)) {
      text = '…';
    } else if (task.phase === 'needs_action') {
      text = '!';
      color = '#f08c00';
    } else if (task.phase === 'failed' || task.phase === 'interrupted') {
      text = '!';
      color = '#e03131';
    }
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (!isActive() && !Object.keys(jobs).length) {
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
    if (isActive() || Object.keys(jobs).length) return;
    const p = await offscreenPing();
    if (p && !p.recording && !p.jobs) chrome.offscreen.closeDocument().catch(() => {});
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
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['src/content/detector.js', 'src/content/content.js'] });
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
  if (starting) return { ok: false, error: toSafeError(new AppError('task_busy', { detail: '正在启动中' })) };
  if (task && task.phase === 'needs_action' && task.tabId === tabId) return resumeCapture();
  if (isActive()) {
    const same = task.tabId === tabId;
    return { ok: same, already: true, task: publicTask(), error: same ? null : toSafeError(new AppError('task_busy', { detail: `来源：${platformLabel(task.platform)} · ${task.title.slice(0, 30)}` })) };
  }
  starting = true;
  try {
    // 注意：仅靠内容脚本匹配，扩展无法读取 tab.url（需 activeTab 或显式主机权限），因此以内容脚本报告的地址为准
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && !isCapturableUrl(tab.url)) throw new AppError('media_not_found', { stage: 'detect', detail: '浏览器内置页面和扩展商店页面无法处理' });
    await ensureContent(tabId);
    const probe = await sendToTab(tabId, { type: 'probe' });
    if (!probe || !probe.ok) throw new AppError('media_not_found', { stage: 'detect' });
    if (!tab.url) tab.url = probe.url;
    const settings = await loadSettings();
    task = newTask({ tab, mode, origin, probe });
    task.monitor = !!settings.record.monitor;
    startKeepAlive();
    await persistTask();
  } catch (e) {
    starting = false;
    return { ok: false, error: toSafeError(e, 'detect') };
  }
  starting = false;
  runPipeline().catch((e) => failTask(e));
  return { ok: true, task: publicTask() };
}

async function runPipeline() {
  const settings = await loadSettings();
  const t = task;
  if (t.platform === 'bilibili' && settings.subtitle.enabled) {
    setPhase('subtitle', '正在获取 B站完整字幕…');
    t.subtitle = { state: 'trying' };
    await persistTask();
    try {
      const sub = await withTimeout(getBiliSubtitle(t, settings), settings.subtitle.timeoutSec * 1000, () => new AppError('sub_timeout', { stage: 'subtitle' }));
      if (task !== t || !isActive()) return;
      await saveSubtitleMaterial(t, sub);
      return afterTranscript(t, settings);
    } catch (e) {
      if (task !== t || !isActive()) return;
      const se = toSafeError(e, 'subtitle');
      t.subtitle = { state: 'failed', reason: se.message + (se.detail ? `（${se.detail}）` : ''), code: se.code };
      if (se.code === 'sub_identity_changed') return failTask(e);
      setPhase('preparing', '字幕不可用，已自动转为录音…');
      await persistTask();
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
    if (!r || !r.ok) throw new AppError(r && r.code === 'network' ? 'sub_access' : 'sub_access', { stage: 'subtitle', diag: r ? { status: r.status || 0 } : null });
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
  await persistTask();
}

// ----- 录音 -----

async function startRecording(t, settings) {
  if (task !== t) return;
  if (!t.hasMedia) {
    if (t.startMode === 'beginning') throw new AppError('media_not_found', { stage: 'detect', detail: '找不到可定位到开头的视频/音频' });
    t.warnings.push('页面上没有可控制的媒体元素：将录制标签页声音，需要你手动“停止并保存”。');
  }
  setPhase('preparing', t.startMode === 'beginning' ? '正在回到开头并准备录音…' : '正在准备录音…');
  await persistTask();
  // 1) 网页准备：暂停、定位起点；YouTube 广告时等待正文
  if (t.hasMedia) {
    const prep = await sendToTab(t.tabId, { type: 'prepare', taskId: t.id, mode: t.startMode }).catch(() => null);
    if (task !== t || !isActive()) return;
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
      setPhase('needs_action', messageFor('capture_not_invoked'));
      t.error = toSafeError(new AppError('capture_not_invoked', { stage: 'capture' }));
      await persistTask();
      return;
    }
    if (/active stream/i.test(msg)) throw new AppError('capture_busy', { stage: 'capture' });
    throw new AppError('capture_failed', { stage: 'capture', detail: msg.slice(0, 100) });
  }
  return beginCapture(t, streamId);
}

async function resumeCapture() {
  const t = task;
  if (!t || t.phase !== 'needs_action') return { ok: false };
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: t.tabId });
    t.error = null;
    beginCapture(t, streamId).catch((e) => failTask(e));
    return { ok: true, task: publicTask() };
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
  await enforceAudioCache([materialId]).catch(() => {});
  await offscreen('rec-start', { streamId, materialId, monitor: t.monitor }).catch(async (e) => {
    await updateMaterial(materialId, (m) => ((m.status = 'failed'), (m.lastError = toSafeError(e, 'capture')), m));
    throw e;
  });
  t.audio = { state: 'recording', seconds: 0 };
  setPhase('recording', '录音中');
  await persistTask();
  if (t.hasMedia) {
    const r = await sendToTab(t.tabId, { type: 'arm-and-play', taskId: t.id }).catch(() => null);
    if (task !== t) return;
    if (!r || !r.ok) {
      await interruptRecording('target_lost', '无法控制网页视频');
      return;
    }
    if (r.blocked) {
      t.warnings.push(messageFor('play_blocked'));
      t.playback = { state: 'blocked' };
    } else t.playback = { state: 'playing' };
    if (r.muted) t.warnings.push('网页视频处于静音或音量为 0，录到的将是静音；请在网页上打开声音。');
    await persistTask();
  }
}

/** 录音结束（正常播完 / 手动 / 中断） */
async function finishRecording(reason, detail, tailOverride) {
  const t = task;
  if (!t || t.audio.state !== 'recording') return;
  t.audio.state = 'stopping';
  setPhase('saving', '正在保存录音…');
  await persistTask();
  let res = null;
  try {
    const tailMs = tailOverride != null ? tailOverride : reason === 'ended' ? 700 : reason === 'manual' ? 200 : 0;
    res = (await offscreen('rec-stop', { tailMs })).result;
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
    }
    return m;
  });
  t.audio = { state: complete ? 'saved' : 'incomplete', seconds, endReason: reason, writeError: res && res.writeError };
  await enforceAudioCache([t.materialId]).catch(() => {});
  return { complete, seconds };
}

async function onMediaEnded(info) {
  const t = task;
  if (!t || t.phase !== 'recording') return;
  t.playback = { state: info.paused ? 'guarded' : 'failed', detail: info.paused ? '已暂停并阻止自动续播' : '未能暂停网页播放' };
  // 正常结束：多收 0.7 s 尾音保住尾句；检测到播放器已自行从头循环：立即停止，不录入重播内容
  const r = await finishRecording('ended', null, info.kind === 'loop' ? 0 : 700);
  if (!r) return;
  // 稍后复核网页是否仍保持暂停（防延迟脚本重新播放）
  setTimeout(() => verifyGuard(t.id), 2500);
  const settings = await loadSettings();
  if (r.seconds < 1) return failTask(new AppError('empty_transcript', { stage: 'capture', detail: '录到的音频不足 1 秒' }));
  if (settings.record.autoTranscribe) return autoTranscribe(t, settings);
  return completeTask('音频已保存（已关闭自动转写）');
}

async function verifyGuard(taskId) {
  if (!task || task.id !== taskId) return;
  const r = await sendToTab(task.tabId, { type: 'guard-status', taskId }).catch(() => null);
  if (!task || task.id !== taskId) return;
  if (r && r.ok) {
    if (r.state === 'guarded') task.playback = { state: 'guarded', detail: r.repauses ? `已暂停（拦截了 ${r.repauses} 次自动播放）` : '已暂停并保持' };
    else if (r.state === 'released') task.playback = { state: 'released', detail: '你已主动继续播放，保护已解除' };
    else if (r.state === 'failed') task.playback = { state: 'failed', detail: '网页仍在播放，未能保持暂停' };
  }
  await persistTask();
}

async function stopTask() {
  await ready;
  const t = task;
  if (!t || !isActive()) return { ok: false };
  if (t.phase === 'recording') {
    const settings = await loadSettings();
    if (settings.record.pauseOnStop && t.hasMedia) {
      const r = await sendToTab(t.tabId, { type: 'pause-for-stop', taskId: t.id }).catch(() => null);
      t.playback = r && r.ok ? { state: 'paused', detail: '已随停止暂停' } : { state: 'failed', detail: '未能暂停网页' };
    } else sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
    const r = await finishRecording('manual');
    if (!r) return { ok: true };
    if (r.seconds < 1) {
      failTask(new AppError('empty_transcript', { stage: 'capture', detail: '录到的音频不足 1 秒' }));
      return { ok: true };
    }
    if (settings.record.transcribeAfterManualStop) autoTranscribe(t, settings);
    else completeTask('音频已保存（手动停止，未自动转写）');
    return { ok: true };
  }
  return cancelTask();
}

async function cancelTask() {
  const t = task;
  if (!t || !isActive()) return { ok: false };
  if (t.phase === 'recording') {
    sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
    await finishRecording('cancelled');
    setPhase('cancelled', '已取消；已录部分保存为不完整音频');
  } else if (t.phase === 'transcribing' || t.phase === 'noting') {
    if (t.jobId) await cancelJob(t.jobId, '已取消');
    setPhase('cancelled', '已取消后续处理；已保存的音频和文字保留');
  } else {
    sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
    setPhase('cancelled', '已取消');
  }
  t.finishedAt = Date.now();
  await persistTask();
  maybeCloseOffscreen();
  return { ok: true };
}

async function interruptRecording(code, detail) {
  const t = task;
  if (!t) return;
  if (t.phase === 'recording') {
    const r = await finishRecording('interrupted', messageFor(code));
    t.error = toSafeError(new AppError(code, { stage: 'capture', detail }));
    setPhase('interrupted', r && r.seconds > 0 ? `录音中断，已保留 ${Math.round(r.seconds)} 秒（不完整，未自动转写）` : '录音中断');
    t.finishedAt = Date.now();
    await persistTask();
    notify(t, '录音中断', describeError(t.error));
    maybeCloseOffscreen();
  } else if (isActive() && ['detecting', 'subtitle', 'preparing', 'waiting_ad', 'needs_action'].includes(t.phase)) {
    await failTask(new AppError(code, { stage: 'detect', detail }));
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
    return completeTask('音频已保存；未自动转写：' + messageFor(c.code));
  }
  setPhase('transcribing', '正在转写…');
  t.stt = { state: 'running', done: 0, total: 0 };
  await persistTask();
  const jobId = await startJob({ kind: 'stt', materialId: t.materialId, cfg: c.cfg, fp: c.fp, taskId: t.id });
  t.jobId = jobId;
  await persistTask();
}

async function afterTranscript(t, settings) {
  if (task !== t) return;
  settings = settings || (await loadSettings());
  if (settings.note.auto) {
    const c = await llmConfig(settings);
    if (!c.ok) {
      t.note = { state: 'skipped', reason: messageFor(c.code) };
      return completeTask('逐字稿已保存；未自动生成笔记：' + messageFor(c.code));
    }
    setPhase('noting', `正在生成${NOTE_MODES[settings.note.mode].label}笔记…`);
    t.note = { state: 'running', mode: settings.note.mode };
    await persistTask();
    t.jobId = await startJob({ kind: 'llm', materialId: t.materialId, cfg: c.cfg, fp: c.fp, taskId: t.id, mode: settings.note.mode });
    await persistTask();
    return;
  }
  return completeTask(t.subtitle.state === 'ok' ? '已保存字幕逐字稿' : '逐字稿已保存');
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
  const t = task && task.id === j.taskId ? task : null;
  if (t && t.jobId === jobId) {
    t.jobId = null;
    if (j.kind === 'stt') {
      if (ok) {
        t.stt = { state: 'done', chars: result.chars, kind: result.kind };
        await persistTask();
        await afterTranscript(t);
      } else if (t.phase !== 'cancelled') {
        t.stt = { state: 'failed', reason: describeError(err) };
        await failTask(err);
      }
    } else {
      if (ok) {
        t.note = { state: 'done', mode: j.mode };
        await completeTask('逐字稿与笔记已保存');
      } else if (t.phase !== 'cancelled') {
        t.note = { state: 'failed', mode: j.mode, reason: describeError(err) };
        t.error = err;
        await completeTask('逐字稿已保存；笔记生成失败（可在材料页重试）', true);
      }
    }
  }
  maybeCloseOffscreen();
}

async function completeTask(text, withProblem = false) {
  const t = task;
  if (!t) return;
  setPhase('done', text);
  t.finishedAt = Date.now();
  await persistTask();
  notify(t, withProblem ? '已完成（部分失败）' : '已完成', text);
  maybeCloseOffscreen();
}

async function failTask(e) {
  const t = task;
  if (!t) return;
  const se = toSafeError(e);
  if (t.phase === 'recording') {
    await finishRecording('interrupted', se.message);
  }
  t.error = se;
  setPhase('failed', describeError(se));
  t.finishedAt = Date.now();
  if (t.hasMedia && t.tabId != null && t.audio.state !== 'saved') sendToTab(t.tabId, { type: 'disarm', taskId: t.id }).catch(() => {});
  await persistTask();
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
      title: `WatchVid4U · ${title}`,
      message: message.slice(0, 180),
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
  const jobId = await startJob({ kind: 'stt', materialId, cfg: c.cfg, fp: c.fp });
  return { ok: true, jobId };
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
  const t = task;
  switch (msg.type) {
    case 'rec-level':
      if (t && t.phase === 'recording' && t.materialId === msg.materialId) {
        t.audio.seconds = msg.seconds;
        const warn = msg.silentSec >= 15 && !t.paused;
        if (warn !== !!t.silenceWarn) {
          t.silenceWarn = warn;
          if (warn) t.warnings = [...t.warnings.filter((w) => !w.startsWith('检测到')), '检测到持续静音：请确认视频在播放且网页没有静音。'];
          else t.warnings = t.warnings.filter((w) => !w.startsWith('检测到'));
        }
        await persistTask();
      }
      return { ok: true };
    case 'rec-track-ended':
      if (t && t.phase === 'recording') await interruptRecording('capture_failed', '浏览器结束了标签页录制');
      return { ok: true };
    case 'rec-write-error':
      if (t && t.phase === 'recording') await interruptRecording(msg.code === 'quota' ? 'quota' : 'db', '录音写入本地失败');
      return { ok: true };
    case 'job-progress':
      if (t && jobs[msg.jobId] && t.jobId === msg.jobId) {
        t.stt = { state: 'running', done: msg.done, total: msg.total };
        t.phaseText = msg.total > 1 ? `正在转写（${msg.done}/${msg.total} 片）…` : '正在转写…';
        await persistTask();
      }
      await updateMaterial(msg.materialId, (m) => (m.processing ? ((m.processing.progress = { done: msg.done, total: msg.total }), m) : null)).catch(() => {});
      return { ok: true };
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
    case 'get-state':
      return { ok: true, task: publicTask(), jobs };
    case 'start':
      return startTask({ tabId: msg.tabId, mode: msg.mode === 'beginning' ? 'beginning' : 'current', origin: 'popup' });
    case 'stop':
      return stopTask();
    case 'cancel':
      return cancelTask();
    case 'resume-capture':
      return resumeCapture();
    case 'set-monitor':
      return setMonitor(!!msg.on);
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
    case 'dismiss-task':
      if (task && !isActive()) {
        task = null;
        await persistTask();
      }
      return { ok: true };
    case 'protected-ids':
      return { ok: true, ids: protectedIds() };
  }
  return { ok: false };
}

function protectedIds() {
  const ids = Object.values(jobs).map((j) => j.materialId);
  if (task && isActive() && task.materialId) ids.push(task.materialId);
  return ids;
}

async function setMonitor(on) {
  const s = await loadSettings();
  s.record.monitor = on;
  await chrome.storage.local.set({ settings: s });
  if (task) {
    task.monitor = on;
    if (task.phase === 'recording') await offscreen('rec-monitor', { on }).catch(() => {});
    await persistTask();
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
  const t = task;
  const own = t && t.tabId === tab.id && (!msg.taskId || msg.taskId === t.id);
  switch (msg.type) {
    case 'float-action':
      if (msg.action === 'start' || msg.action === 'start-beginning') return startTask({ tabId: tab.id, mode: msg.action === 'start-beginning' ? 'beginning' : 'current', origin: 'float' });
      if (msg.action === 'stop') return t && t.tabId === tab.id ? stopTask() : { ok: false, error: toSafeError(new AppError('task_busy', { detail: '只能在任务来源页停止' })) };
      if (msg.action === 'cancel') return t && t.tabId === tab.id ? cancelTask() : { ok: false };
      if (msg.action === 'monitor') return setMonitor(!!msg.on);
      if (msg.action === 'open-library') {
        openLibrary(t && t.materialId);
        return { ok: true };
      }
      if (msg.action === 'open-options') {
        chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      return { ok: false };
    case 'get-task':
      return { ok: true, task: publicTask(), here: !!(t && t.tabId === tab.id) };
    case 'media-event':
      if (!own) return { ok: false };
      return mediaEvent(msg);
    case 'diag':
      return storeDiag(msg.entry);
  }
  return { ok: false };
}

async function mediaEvent(msg) {
  const t = task;
  switch (msg.event) {
    case 'waiting-ad':
      if (t.phase === 'preparing') {
        setPhase('waiting_ad', '正在等待广告结束，确认正文起点…（可取消）');
        await persistTask();
      }
      break;
    case 'ad-done':
      if (t.phase === 'waiting_ad') {
        setPhase('preparing', '广告已结束，正在准备录音…');
        await persistTask();
      }
      break;
    case 'ad':
      if (t.phase === 'recording') {
        offscreen('rec-ad', { ad: !!msg.ad }).catch(() => {});
        t.adNow = !!msg.ad;
        await persistTask();
      }
      break;
    case 'paused':
      if (t.phase === 'recording') {
        t.paused = true;
        offscreen('rec-gate', { paused: true }).catch(() => {});
        t.phaseText = '视频已暂停，录音同步暂停';
        await persistTask();
      }
      break;
    case 'playing':
      if (t.phase === 'recording') {
        t.paused = false;
        offscreen('rec-gate', { paused: false }).catch(() => {});
        t.phaseText = '录音中';
        if (t.playback.state === 'blocked') {
          t.playback = { state: 'playing' };
          t.warnings = t.warnings.filter((w) => w !== messageFor('play_blocked'));
        }
        await persistTask();
      }
      break;
    case 'progress':
      if (t.phase === 'recording') {
        t.media = { currentTime: msg.currentTime, duration: msg.duration };
        await chrome.storage.session.set({ task });
      }
      break;
    case 'ended':
      await onMediaEnded(msg);
      break;
    case 'unknown-end':
      if (t.phase === 'recording' && !t.warnings.includes(msg.text)) {
        t.warnings.push(msg.text);
        await persistTask();
      }
      break;
    case 'target-lost':
      if (t.phase === 'recording') await interruptRecording(msg.code || 'target_lost', msg.detail);
      else if (isActive() && t.phase !== 'transcribing' && t.phase !== 'noting' && t.phase !== 'saving') await failTask(new AppError(msg.code || 'target_lost', { stage: 'playback', detail: msg.detail }));
      break;
    case 'guard':
      if (t.id === msg.taskId && !isActive()) {
        if (msg.state === 'released') t.playback = { state: 'released', detail: '你已主动继续播放，保护已解除' };
        else if (msg.state === 'repaused') t.playback = { state: 'guarded', detail: `已暂停（拦截了 ${msg.count} 次自动播放）` };
        else if (msg.state === 'failed') t.playback = { state: 'failed', detail: msg.detail || '未能保持暂停' };
        await persistTask();
      } else if (t.id === msg.taskId && msg.state === 'repaused') {
        t.playback = { state: 'guarded', detail: `已暂停（拦截了 ${msg.count} 次自动播放）` };
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
    await stopTask();
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
  if (task && task.tabId === tabId && isActive()) {
    if (task.phase === 'recording') await interruptRecording('tab_closed');
    else if (['detecting', 'subtitle', 'preparing', 'waiting_ad', 'needs_action'].includes(task.phase)) await failTask(new AppError('tab_closed', { stage: 'detect' }));
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await ready;
  if (!task || task.tabId !== tabId || !isActive()) return;
  if (!['detecting', 'subtitle', 'preparing', 'waiting_ad', 'recording', 'needs_action'].includes(task.phase)) return;
  if (info.url) {
    const key = videoKeyFromUrl(info.url);
    if (task.videoKey && key && key !== task.videoKey) {
      if (task.phase === 'recording') await interruptRecording('navigated', '页面切换到了其他视频');
      else await failTask(new AppError('navigated', { stage: 'detect' }));
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
