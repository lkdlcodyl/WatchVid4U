import { loadSettings, saveSettings, setKey, makeConsent, sttEndpoint, llmEndpoint, localEndpoint } from './src/shared/settings.js';
import { listMaterials, getMaterial, getChunks, getFrames, putMaterial, addChunk, deleteMaterials } from './src/shared/db.js';
import { floatToInt16, frameRms } from './src/shared/wav.js';

const sw = (type, payload = {}) => chrome.runtime.sendMessage({ target: 'sw', type, ...payload });

window.T = {
  sw,
  async configure({ sttVariant = 'stt', llmVariant = 'llm', patch = {} } = {}) {
    const s = await loadSettings();
    s.stt.provider = 'cloud';
    s.stt.baseUrl = `http://127.0.0.1:8790/mock/${sttVariant}/v1`;
    s.llm.baseUrl = `http://127.0.0.1:8790/mock/${llmVariant}/v1`;
    s.llm.model = 'mock-llm';
    s.consent.stt = makeConsent(sttEndpoint(s.stt.baseUrl), 'transcribe');
    s.consent.llm = makeConsent(llmEndpoint(s.llm.baseUrl), 'notes');
    s.notify.enabled = false;
    for (const [path, v] of Object.entries(patch)) {
      const ks = path.split('.');
      let o = s;
      for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
      o[ks[ks.length - 1]] = v;
    }
    await chrome.storage.local.set({ settings: s });
    await setKey('stt', sttEndpoint(s.stt.baseUrl), 'test-stt-key', false);
    await setKey('llm', llmEndpoint(s.llm.baseUrl), 'test-llm-key', false);
    return true;
  },
  async configureLocal(port, diarize = true) {
    const s = await loadSettings();
    s.stt.provider = 'local';
    s.local.baseUrl = `http://127.0.0.1:${port}`;
    s.local.diarize = diarize;
    s.consent.local = makeConsent(localEndpoint(s.local.baseUrl), 'transcribe');
    await chrome.storage.local.set({ settings: s });
    return true;
  },
  /** 开启截帧并确认“生成笔记时附带画面”（绑定当前笔记服务地址） */
  async enableFrames(intervalSec = 5, maxFrames = 20, consent = true) {
    const s = await loadSettings();
    s.frames = { enabled: true, intervalSec };
    s.llm.sendFrames = true;
    s.llm.maxFrames = maxFrames;
    s.consent.frames = consent ? makeConsent(llmEndpoint(s.llm.baseUrl), 'frames') : null;
    await chrome.storage.local.set({ settings: s });
    return true;
  },
  async frames(id) {
    return (await getFrames(id)).map((f) => ({ seq: f.seq, t: f.t, type: f.blob.type, bytes: f.bytes, w: f.w, h: f.h }));
  },
  async patchSettings(patch) {
    const s = await loadSettings();
    for (const [path, v] of Object.entries(patch)) {
      const ks = path.split('.');
      let o = s;
      for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
      o[ks[ks.length - 1]] = v;
    }
    await chrome.storage.local.set({ settings: s });
    return true;
  },
  // 扩展仅凭内容脚本匹配读不到 tab.url（与真实环境一致），因此按“最新打开的网页标签”定位
  async tabId() {
    const self = (await chrome.tabs.getCurrent()).id;
    const tabs = (await chrome.tabs.query({})).filter((x) => x.id !== self && !(x.url || '').startsWith('chrome-extension://'));
    return tabs.length ? Math.max(...tabs.map((x) => x.id)) : null;
  },
  /** 最近开始的任务（兼容单任务场景） */
  async task() {
    const all = Object.values((await chrome.storage.session.get('tasks')).tasks || {});
    return all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  },
  /** 指定标签页的任务（进行中优先） */
  async taskForTab(tabId) {
    const all = Object.values((await chrome.storage.session.get('tasks')).tasks || {}).filter((t) => t.tabId === tabId);
    all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return all[0] || null;
  },
  async materials() {
    return (await listMaterials()).map((m) => ({ id: m.id, title: m.title, platform: m.platform, source: m.source, status: m.status, processing: m.processing, audio: m.audio, transcript: m.transcript ? { kind: m.transcript.kind, effective: m.transcript.effective, source: m.transcript.source, droppedSegments: m.transcript.droppedSegments, sliceCount: m.transcript.sliceCount } : null, transcriptVersion: m.transcriptVersion, notes: m.notes, lastError: m.lastError, sttPartial: m.sttPartial ? { failedAt: m.sttPartial.failedAt, done: m.sttPartial.results.length, total: m.sttPartial.totalSlices } : null, subtitle: m.subtitle }));
  },
  async material(id) {
    return getMaterial(id);
  },
  async audioInfo(id) {
    const cs = await getChunks(id);
    const rms = cs.flatMap((c) => c.rms);
    const samples = cs.reduce((s, c) => s + c.sampleCount, 0);
    return { chunks: cs.length, samples, seconds: samples / 16000, headRms: Math.max(...rms.slice(0, 5)), maxRms: Math.max(...rms) };
  },
  /** 合成长音频材料：语音样（调制噪声）与停顿交替 */
  async synthMaterial(id, seconds) {
    await deleteMaterials([id]).catch(() => {});
    const sr = 16000;
    let seq = 0;
    for (let start = 0; start < seconds * sr; start += 2 * sr) {
      const n = Math.min(2 * sr, seconds * sr - start);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = (start + i) / sr;
        const speaking = t % 13 < 11.5; // 每 13 秒停顿 1.5 秒
        f[i] = speaking ? 0.2 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0.0002 * Math.sin(t);
      }
      const pcm = floatToInt16(f);
      await addChunk({ materialId: id, seq: seq++, startSample: start, sampleCount: n, blob: new Blob([pcm.buffer]), rms: frameRms(f, 1600), bytes: pcm.byteLength });
    }
    await putMaterial({ id, createdAt: Date.now(), title: '合成长音频', platform: 'generic', source: 'audio', audio: { sampleRate: sr, samples: seconds * sr, bytes: seconds * sr * 2, chunks: seq, complete: true, endReason: 'ended', adIntervals: [] }, transcript: null, notes: {}, status: 'ready' });
    return true;
  },
  async clearAll() {
    const all = await listMaterials();
    await deleteMaterials(all.map((m) => m.id));
    for (let i = 0; i < 6; i++) await sw('cancel');
    await sw('dismiss-task');
    return all.length;
  },
};
window.__ready = true;
