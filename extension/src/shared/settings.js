import { kvGet, kvSet, kvDelete } from './db.js';

// 设置、授权与密钥。纯函数部分可在任何环境测试；chrome.* 访问集中在 load/save 系列函数。

export const CONSENT_VERSION = 1;

export const DEFAULT_STT_PROMPT = '以下是普通话的句子，使用简体中文和标点符号，如逗号、句号、问号。';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  stt: {
    provider: 'cloud', // cloud | local
    baseUrl: '',
    model: 'whisper-large-v3',
    language: 'zh',
    prompt: DEFAULT_STT_PROMPT,
    responseFormat: 'verbose_json', // verbose_json | json | text
    maxUploadMB: 25,
    maxSliceMin: 10,
    timeoutSec: 300,
    filterLowConfidence: true,
  },
  local: {
    baseUrl: 'http://127.0.0.1:8765',
    model: 'auto',
    diarize: true,
    maxUploadMB: 2048,
    timeoutSec: 3600,
  },
  llm: {
    baseUrl: '',
    model: '',
    maxInputChars: 60000,
    maxOutputTokens: 4096,
    timeoutSec: 240,
    temperature: 0.3,
    sendFrames: false, // 生成笔记时附带录制时截取的画面（需模型支持图片输入，且需单独授权）
    maxFrames: 20, // 每次最多附带的画面数
  },
  // 录制时定时截取画面（只保存在本机；是否发给模型由 llm.sendFrames 决定）
  frames: { enabled: false, intervalSec: 30 },
  consent: { stt: null, local: null, llm: null, frames: null },
  keyPersist: { stt: true, local: true, llm: true },
  subtitle: {
    enabled: true,
    acceptAuto: true,
    acceptUnknown: true,
    allowNonChinese: false,
    useLogin: false,
    timeoutSec: 12,
  },
  record: {
    maxConcurrent: 3, // 最多同时录制的标签页数（1–6）
    monitor: false,
    pauseOnStop: true,
    autoTranscribe: true,
    transcribeAfterManualStop: true,
  },
  note: { auto: false, mode: 'concise', ignorePromo: false },
  notify: { enabled: true },
  float: { enabled: true, hotkeyEnabled: false, hotkey: '`' },
  ui: { theme: 'system', scale: 100, lang: 'auto' }, // lang: auto（跟随浏览器）| zh | en // scale: 用户微调百分比 80–125（旧版 density 会被迁移，见 shared/uiscale.js）
  diag: { youtube: false },
});

export function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) {
    const bv = base[k];
    const ov = over ? over[k] : undefined;
    if (bv && typeof bv === 'object' && !Array.isArray(bv)) out[k] = deepMerge(bv, ov && typeof ov === 'object' ? ov : undefined);
    else out[k] = ov === undefined ? bv : ov;
  }
  // 授权记录为 null|object，需要原样保留
  if (over && base === DEFAULT_SETTINGS) out.consent = { ...DEFAULT_SETTINGS.consent, ...(over.consent || {}) };
  return out;
}

export function normalizeSettings(raw) {
  return deepMerge(DEFAULT_SETTINGS, raw || {});
}

/** 校验服务地址。返回 {ok, url, error} */
export function validateServiceUrl(input) {
  const s = String(input || '').trim();
  if (!s) return { ok: false, error: 'empty' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (u.username || u.password) return { ok: false, error: 'invalid_url' };
  const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol === 'https:') return { ok: true, url: u, loopback: loop };
  if (u.protocol === 'http:' && loop) return { ok: true, url: u, loopback: true };
  return { ok: false, error: 'invalid_url' };
}

function stripSlash(p) {
  return p.replace(/\/+$/, '');
}

/** OpenAI 兼容转写端点：可填 base（…/v1）或完整端点 */
export function sttEndpoint(baseUrl) {
  const v = validateServiceUrl(baseUrl);
  if (!v.ok) return null;
  const u = v.url;
  let path = stripSlash(u.pathname);
  if (!/\/audio\/transcriptions$/.test(path)) path += '/audio/transcriptions';
  return `${u.origin}${path}${u.search}`;
}

/**
 * 本地 OpenAI 兼容转写端点（只接受本机回环地址）：
 * 只填 http://127.0.0.1:端口 时默认 /v1/audio/transcriptions；填 …/v1 或完整 …/audio/transcriptions 时按原样补全。
 */
export function localEndpoint(baseUrl) {
  const v = validateServiceUrl(baseUrl);
  if (!v.ok || !v.loopback) return null;
  const u = v.url;
  let path = stripSlash(u.pathname);
  if (!path) path = '/v1/audio/transcriptions';
  else if (!/\/audio\/transcriptions$/.test(path)) path += '/audio/transcriptions';
  return `${u.origin}${path}${u.search}`;
}

/** Chat Completions 端点：兼容填写 https://host/v1、https://host/v1/ 或完整 …/chat/completions */
export function llmEndpoint(baseUrl) {
  const v = validateServiceUrl(baseUrl);
  if (!v.ok) return null;
  const u = v.url;
  let path = stripSlash(u.pathname);
  if (!/\/chat\/completions$/.test(path)) path += '/chat/completions';
  return `${u.origin}${path}${u.search}`;
}

/** 某服务（stt | local | llm）当前设置下的接收端点 */
export function serviceEndpoint(settings, service) {
  if (service === 'stt') return sttEndpoint(settings.stt.baseUrl);
  if (service === 'local') return localEndpoint(settings.local.baseUrl);
  return llmEndpoint(settings.llm.baseUrl);
}

export function originPattern(endpoint) {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.hostname}/*`;
}

/** 当前转写服务描述（云端或本地） */
export function sttTarget(settings) {
  if (settings.stt.provider === 'local') {
    // 本地服务的 Key 可选：填了就带上（部分本地服务要求），不填也可用
    return { service: 'local', keyService: 'local', endpoint: localEndpoint(settings.local.baseUrl), needsKey: false, model: settings.local.model, consent: settings.consent.local };
  }
  return { service: 'stt', keyService: 'stt', endpoint: sttEndpoint(settings.stt.baseUrl), needsKey: true, model: settings.stt.model, consent: settings.consent.stt };
}

export function llmTarget(settings) {
  return { service: 'llm', endpoint: llmEndpoint(settings.llm.baseUrl), needsKey: true, model: settings.llm.model, consent: settings.consent.llm };
}

/** 授权只绑定接收端点与用途版本；换 Key/模型不失效，换地址失效 */
export function consentValid(consent, endpoint) {
  return !!(consent && endpoint && consent.endpoint === endpoint && consent.version === CONSENT_VERSION);
}

export function makeConsent(endpoint, purpose) {
  return { endpoint, purpose, version: CONSENT_VERSION, grantedAt: Date.now() };
}

/**
 * 应用一次设置修改：若某服务的接收端点发生变化，撤销其授权并标记需清除旧 Key（不把旧 Key 发往新地址）。
 * 返回 {settings, clearKeys:[service...]}
 */
export function applySettingsChange(prev, next) {
  const out = normalizeSettings(next);
  const clearKeys = [];
  const prevStt = sttEndpoint(prev.stt.baseUrl);
  const nextStt = sttEndpoint(out.stt.baseUrl);
  if (prevStt !== nextStt) {
    if (!consentValid(out.consent.stt, nextStt)) out.consent.stt = null;
    clearKeys.push('stt');
  }
  const prevLocal = localEndpoint(prev.local.baseUrl);
  const nextLocal = localEndpoint(out.local.baseUrl);
  if (prevLocal !== nextLocal) {
    if (!consentValid(out.consent.local, nextLocal)) out.consent.local = null;
    clearKeys.push('local');
  }
  const prevLlm = llmEndpoint(prev.llm.baseUrl);
  const nextLlm = llmEndpoint(out.llm.baseUrl);
  if (prevLlm !== nextLlm) {
    if (!consentValid(out.consent.llm, nextLlm)) out.consent.llm = null;
    clearKeys.push('llm');
  }
  return { settings: out, clearKeys };
}

/** 判断某服务是否可用于自动流程；返回 {ok, code} */
export function readiness(target, key, hasPermission) {
  if (!target.endpoint) return { ok: false, code: 'not_configured' };
  if (!consentValid(target.consent, target.endpoint)) return { ok: false, code: 'consent_missing' };
  if (!hasPermission) return { ok: false, code: 'permission_missing' };
  if (target.needsKey && !key) return { ok: false, code: 'key_missing' };
  return { ok: true };
}

/** 单片最长秒数：受上传上限（16kHz/16bit 单声道 WAV = 32000 B/s，留 5% 余量）与分片时长上限共同约束 */
export function sliceSeconds(maxUploadMB, maxSliceMin) {
  const bySize = Math.floor((maxUploadMB * 1024 * 1024 * 0.95 - 44) / 32000);
  const byTime = Math.round(maxSliceMin * 60);
  return Math.max(30, Math.min(bySize, byTime));
}

// ---------- chrome.storage 访问 ----------

const SETTINGS_KEY = 'settings';

export async function loadSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(r[SETTINGS_KEY]);
}

export async function saveSettings(next) {
  const prev = await loadSettings();
  const { settings, clearKeys } = applySettingsChange(prev, next);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  for (const s of clearKeys) {
    const sec = await readSecret(s);
    const ep = serviceEndpoint(settings, s);
    if (sec && sec.endpoint !== ep) await clearKey(s);
  }
  return settings;
}

function secretKey(service) {
  return `secret.${service}`;
}

// Key 存储：默认只在 chrome.storage.session（浏览器关闭即清除，内容脚本不可读）；
// 用户选择“记住在本机”时存入扩展专属 IndexedDB（未加密，存储于本机浏览器配置目录）。
async function readSecret(service) {
  const k = secretKey(service);
  const s = await chrome.storage.session.get(k);
  if (s[k]) return s[k];
  return (await kvGet(k)) || null;
}

/** 只返回与当前端点绑定的 Key；端点不一致视为无 Key（不把旧 Key 发往新地址） */
export async function getKey(service, endpoint) {
  const sec = await readSecret(service);
  if (!sec || !sec.key) return '';
  if (sec.endpoint !== endpoint) return '';
  return sec.key;
}

export async function hasStoredKey(service) {
  const sec = await readSecret(service);
  return sec ? { exists: !!sec.key, persisted: !!sec.persisted, endpoint: sec.endpoint } : { exists: false };
}

export async function setKey(service, endpoint, key, persist) {
  const k = secretKey(service);
  const value = { key: String(key).trim(), endpoint, persisted: !!persist, savedAt: Date.now() };
  await chrome.storage.session.remove(k);
  await kvDelete(k);
  if (persist) await kvSet(k, value);
  else await chrome.storage.session.set({ [k]: value });
  await bumpSecretRev(service);
}

export async function clearKey(service) {
  const k = secretKey(service);
  await chrome.storage.session.remove(k);
  await kvDelete(k);
  await bumpSecretRev(service);
}

/** Key 变化的信号（不含 Key 本身），用于让进行中的任务停止后续发送 */
async function bumpSecretRev(service) {
  await chrome.storage.session.set({ [`secretRev.${service}`]: Date.now() });
}

export async function hasOriginPermission(endpoint) {
  if (!endpoint) return false;
  try {
    return await chrome.permissions.contains({ origins: [originPattern(endpoint)] });
  } catch {
    return false;
  }
}

/** 当前操作系统（用于界面密度的自动适配） */
export function detectOS(nav = typeof navigator !== 'undefined' ? navigator : {}) {
  const p = ((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  if (p.includes('cros') || p.includes('chrome os')) return 'chromeos';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return 'other';
}

