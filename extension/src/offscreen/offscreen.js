// Offscreen 文档：录音与处理的工作者。只接受来自本扩展 Service Worker 的消息。
import { TabRecorder } from './recorder.js';
import { runTranscribe, runNote } from './jobs.js';
import { toSafeError } from '../shared/errors.js';

const emit = (type, payload) => chrome.runtime.sendMessage({ target: 'sw', type, ...payload }).catch(() => {});
const recorder = new TabRecorder(emit);
const jobs = new Map(); // jobId -> AbortController

// 保持 SW 在任务期间活跃并能感知 offscreen 存活
setInterval(() => {
  if (recorder.busy || jobs.size) emit('offscreen-heartbeat', { recordingIds: recorder.ids(), jobs: jobs.size });
}, 20000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (sender.id !== chrome.runtime.id || sender.tab) return false; // 只信任扩展自身的非页面上下文
  handle(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: toSafeError(e, msg.stage || null) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'ping':
      return { recording: recorder.busy, recordingIds: recorder.ids(), jobs: jobs.size };
    case 'rec-start':
      return recorder.start(msg);
    case 'rec-stop':
      return { result: await recorder.stop(msg.materialId, { tailMs: msg.tailMs || 0 }) };
    case 'rec-monitor':
      recorder.setMonitor(msg.materialId, !!msg.on);
      return {};
    case 'rec-gate':
      recorder.setGate(msg.materialId, !!msg.paused);
      return {};
    case 'rec-ad':
      recorder.setAd(msg.materialId, !!msg.ad);
      return {};
    case 'job-transcribe':
      return runJob(msg.jobId, (signal) =>
        runTranscribe({
          materialId: msg.materialId,
          cfg: msg.cfg,
          signal,
          onProgress: (p) => emit('job-progress', { jobId: msg.jobId, materialId: msg.materialId, kind: 'stt', ...p }),
        }),
      );
    case 'job-note':
      return runJob(msg.jobId, (signal) => runNote({ materialId: msg.materialId, mode: msg.mode, cfg: msg.cfg, signal }));
    case 'job-cancel': {
      const c = jobs.get(msg.jobId);
      if (c) c.abort();
      return { cancelled: !!c };
    }
    case 'idle-check':
      return { idle: !recorder.busy && jobs.size === 0 };
    default:
      throw new Error('unknown message');
  }
}

/** 任务立即返回“已开始”，结果通过事件回报（SW 若被回收重启也能收到） */
async function runJob(jobId, fn) {
  if (jobs.has(jobId)) return { started: false, duplicate: true };
  const ctrl = new AbortController();
  jobs.set(jobId, ctrl);
  fn(ctrl.signal)
    .then((result) => emit('job-finished', { jobId, ok: true, result }))
    .catch((e) => emit('job-finished', { jobId, ok: false, error: toSafeError(e) }))
    .finally(() => jobs.delete(jobId));
  return { started: true };
}
