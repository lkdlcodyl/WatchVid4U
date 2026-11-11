import { applyTheme, h, toast, confirmDialog, downloadBlob, errText } from './ui.js';
import {
  loadSettings,
  saveSettings,
  sttEndpoint,
  localEndpoint,
  llmEndpoint,
  consentValid,
  makeConsent,
  originPattern,
  getKey,
  setKey,
  clearKey,
  hasStoredKey,
  serviceEndpoint,
  sliceSeconds,
  DEFAULT_STT_PROMPT,
} from '../shared/settings.js';
import { transcribeBlob } from '../shared/stt.js';
import { chatComplete } from '../shared/llm.js';
import { LLM_TEST_MESSAGES, NOTE_MODES } from '../shared/prompts.js';
import { testToneWav } from '../shared/wav.js';
import { requestText } from '../shared/http.js';
import { totalAudioBytes, AUDIO_CACHE_LIMIT } from '../shared/db.js';
import { fmtBytes, fmtTime } from '../shared/format.js';
import { toSafeError } from '../shared/errors.js';

let S = null;
const root = document.getElementById('sections');

const STT_PRESETS = [
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3', format: 'verbose_json', mb: 25 },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', format: 'verbose_json', mb: 25 },
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', format: 'json', mb: 25 },
];
const LLM_PRESETS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-flash' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
];

init();

async function init() {
  applyTheme();
  S = await loadSettings();
  if (location.hash === '#welcome') document.getElementById('welcome').hidden = false;
  render();
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area === 'local' && ch.settings) {
      const prev = S;
      S = await loadSettings();
      // 其他页面修改时只刷新状态行，避免打断正在编辑的表单
      if (JSON.stringify(prev.consent) !== JSON.stringify(S.consent)) refreshStatus();
    }
    if (area === 'local' && ch['diag.youtube']) renderDiagTable();
  });
  const links = [...document.querySelectorAll('.nav a[href^="#"]')];
  const obs = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) links.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + e.target.id)));
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('.sec[id]').forEach((s) => obs.observe(s));
}

function render() {
  root.replaceChildren(sttSection(), llmSection(), subtitleSection(), recordSection(), shortcutSection(), storageSection(), diagSection(), privacySection());
  refreshStatus();
  if (location.hash && location.hash !== '#welcome') document.querySelector(location.hash)?.scrollIntoView();
}

// ---------- 通用控件 ----------
function get(path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), S);
}

async function setPath(path, value) {
  const next = structuredClone(S);
  const ks = path.split('.');
  let o = next;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = value;
  S = await saveSettings(next);
  flashSaved();
}

let savedTimer = null;
function flashSaved() {
  clearTimeout(savedTimer);
  toast('已保存', 1500);
}

function toggle(path, title, hint, onChange) {
  const input = h('input', {
    type: 'checkbox',
    checked: !!get(path),
    onchange: async (e) => {
      await setPath(path, e.target.checked);
      onChange && onChange(e.target.checked);
    },
  });
  return h('label', { class: 'check' }, input, h('span', null, h('b', { text: title }), hint ? h('div', { class: 'hint', text: hint }) : null));
}

function numberField(path, label, { min, max, step = 1, unit = '', hint = '' }) {
  const id = 'f_' + path.replace(/\./g, '_');
  const input = h('input', { class: 'input', id, type: 'number', min, max, step, value: get(path) });
  input.addEventListener('change', async () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = get(path);
    v = Math.max(min, Math.min(max, v));
    input.value = v;
    await setPath(path, v);
  });
  return h('div', { class: 'field' }, h('label', { for: id, text: `${label}${unit ? `（${unit}）` : ''}` }), input, hint ? h('div', { class: 'hint', text: hint }) : null);
}

function section(id, title, lead, ...kids) {
  return h('section', { class: 'card sec', id, 'aria-labelledby': id + '_h' }, h('h2', { id: id + '_h', text: title }), lead ? h('p', { class: 'lead', text: lead }) : null, ...kids);
}

function step(title, ...kids) {
  return h('div', { class: 'step' }, h('h3', { text: title }), ...kids);
}

// ---------- 语音转写 ----------
const sttForm = {};

function sttSection() {
  const provider = S.stt.provider;
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '转写方式' });
  for (const [k, label] of [['cloud', '云端 API（推荐）'], ['local', '本地服务（可选）']]) {
    seg.append(h('button', { 'aria-pressed': String(provider === k), text: label, onclick: async () => { await setPath('stt.provider', k); render(); } }));
  }
  const body = provider === 'local' ? localConfig() : cloudConfig();
  return section('stt', '语音转写（STT）', '录音结束后把音频发给转写服务得到中文逐字稿。B站有字幕时不需要。', step('① 选择方式', seg, h('p', { class: 'hint', text: provider === 'local' ? '本地服务运行在你的电脑上（127.0.0.1 / localhost）。可使用本插件自带后端（支持区分说话人，见 local-backend/README.md），也可使用任何兼容 OpenAI /audio/transcriptions 的本地转写服务。' : '兼容 OpenAI /audio/transcriptions 的同步转写服务，无需安装本地环境。本插件不内置任何共享 Key，也不保证某服务长期免费。' })), ...body);
}

function cloudConfig() {
  const f = sttForm;
  f.base = h('input', { class: 'input', id: 'stt_base', type: 'url', placeholder: 'https://api.groq.com/openai/v1', value: S.stt.baseUrl, autocomplete: 'off', spellcheck: 'false' });
  f.model = h('input', { class: 'input', id: 'stt_model', value: S.stt.model, autocomplete: 'off', spellcheck: 'false' });
  f.key = h('input', { class: 'input', id: 'stt_key', type: 'password', autocomplete: 'off', placeholder: '粘贴 API Key' });
  f.persist = h('input', { type: 'checkbox', checked: S.keyPersist.stt });
  f.endpoint = h('div', { class: 'endpoint' });
  f.lang = h('input', { class: 'input', id: 'stt_lang', value: S.stt.language });
  f.prompt = h('textarea', { class: 'input', id: 'stt_prompt', rows: 2 });
  f.prompt.value = S.stt.prompt;
  f.format = h('select', { class: 'input', id: 'stt_fmt' }, ['verbose_json', 'json', 'text'].map((v) => h('option', { value: v, text: { verbose_json: 'verbose_json（带分段与置信度，推荐）', json: 'json', text: 'text' }[v], selected: S.stt.responseFormat === v })));
  f.mb = h('input', { class: 'input', id: 'stt_mb', type: 'number', min: 1, max: 1024, value: S.stt.maxUploadMB });
  f.slice = h('input', { class: 'input', id: 'stt_slice', type: 'number', min: 1, max: 60, value: S.stt.maxSliceMin });
  f.timeout = h('input', { class: 'input', id: 'stt_to', type: 'number', min: 30, max: 3600, value: S.stt.timeoutSec });
  f.filter = h('input', { type: 'checkbox', checked: S.stt.filterLowConfidence });
  const updEp = () => {
    const ep = sttEndpoint(f.base.value);
    f.base.classList.toggle('invalid', !!f.base.value && !ep);
    f.endpoint.textContent = ep ? `请求地址：${ep}` : f.base.value ? '地址无效：需要 https://（本地服务请用“本地服务”方式）' : '';
    const sec = sliceSeconds(Number(f.mb.value) || 25, Number(f.slice.value) || 10);
    f.sliceInfo.textContent = `长音频将自动按不超过 ${Math.round(sec / 60)} 分钟/片（约 ${(sec * 32000 / 1048576).toFixed(1)} MB）在静音处分片，每片一次请求，可能分别计费。`;
  };
  f.sliceInfo = h('div', { class: 'hint' });
  [f.base, f.mb, f.slice].forEach((x) => x.addEventListener('input', updEp));
  const presets = h('div', { class: 'presets' }, h('span', { class: 'hint', text: '示例：' }), STT_PRESETS.map((p) => h('button', { class: 'btn small', text: p.name, onclick: () => { f.base.value = p.baseUrl; f.model.value = p.model; f.format.value = p.format; f.mb.value = p.mb; updEp(); } })));
  f.status = h('div', { class: 'status-line' });
  f.testOut = h('div', { class: 'test-out' });
  queueMicrotask(updEp);
  return [
    step(
      '② 配置服务',
      presets,
      h('div', { class: 'field' }, h('label', { for: 'stt_base', text: '服务地址' }), f.base, f.endpoint, h('div', { class: 'hint', text: '可填写 …/v1 或完整的 …/audio/transcriptions 地址。' })),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'stt_model', text: '模型' }), f.model), h('div', { class: 'field' }, h('label', { for: 'stt_key', text: 'API Key' }), f.key)),
      h('label', { class: 'check' }, f.persist, h('span', null, h('b', { text: '在本机记住 Key' }), h('div', { class: 'hint', text: '默认只保存在本次浏览器会话中（关闭浏览器即清除）。勾选后以未加密形式保存在本机浏览器的扩展数据中，网页和内容脚本无法读取。' }))),
      h(
        'details',
        null,
        h('summary', { text: '高级：语言、标点、分片与限额' }),
        h('div', { class: 'grid-2', style: 'margin-top:.8rem' }, h('div', { class: 'field' }, h('label', { for: 'stt_lang', text: '语言代码' }), f.lang), h('div', { class: 'field' }, h('label', { for: 'stt_fmt', text: '响应格式' }), f.format)),
        h('div', { class: 'field' }, h('label', { for: 'stt_prompt', text: '中文标点引导（prompt）' }), f.prompt, h('div', { class: 'hint' }, '引导模型输出带标点的简体中文；分片时会附上前一片末尾文字以保持上下文。', h('button', { class: 'btn small ghost', text: '恢复默认', onclick: () => (f.prompt.value = DEFAULT_STT_PROMPT) }))),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'stt_mb', text: '单次上传上限（MB）' }), f.mb), h('div', { class: 'field' }, h('label', { for: 'stt_slice', text: '单片最长（分钟）' }), f.slice), h('div', { class: 'field' }, h('label', { for: 'stt_to', text: '单片超时（秒）' }), f.timeout)),
        h('label', { class: 'check' }, f.filter, h('span', null, h('b', { text: '按模型置信度省略疑似无语音段落' }), h('div', { class: 'hint', text: '使用 Whisper 自带的 no_speech_prob / avg_logprob 判据抑制静音处的幻觉；原始输出仍保存在本机。' }))),
      ),
      f.sliceInfo,
    ),
    step(
      '③ 用途与授权',
      h('ul', { class: 'uses' }, h('li', { text: '发送：当前录音的音频（WAV 16 kHz 单声道）、模型名、语言、标点引导与前一片末尾的少量文字。' }), h('li', { text: '不发送：网页标题、网址、账号或其他材料。' }), h('li', { text: '用途：仅用于把这次录音转成逐字稿。授权后，日常一键流程不再重复确认。' }), h('li', { text: '费用：由服务商按其规则计费；长音频分片会产生多次请求。' })),
      f.status,
    ),
    step(
      '④ 保存与测试',
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', text: '保存并授权', onclick: saveCloudStt }), h('button', { class: 'btn', text: '测试连接', onclick: testCloudStt }), h('button', { class: 'btn ghost', text: '撤销授权', onclick: () => revoke('stt') }), h('button', { class: 'btn ghost', text: '清除 Key', onclick: async () => { await clearKey('stt'); f.key.value = ''; refreshStatus(); toast('已清除 Key'); } })),
      h('p', { class: 'hint', text: '保存设置不会调用服务；“测试连接”只发送一段 1.5 秒的固定测试音，不使用你的录音。' }),
      f.testOut,
    ),
  ];
}

function readCloudSttForm() {
  const f = sttForm;
  const next = structuredClone(S);
  next.stt.baseUrl = f.base.value.trim();
  next.stt.model = f.model.value.trim();
  next.stt.language = f.lang.value.trim();
  next.stt.prompt = f.prompt.value;
  next.stt.responseFormat = f.format.value;
  next.stt.maxUploadMB = clampNum(f.mb.value, 1, 1024, 25);
  next.stt.maxSliceMin = clampNum(f.slice.value, 1, 60, 10);
  next.stt.timeoutSec = clampNum(f.timeout.value, 30, 3600, 300);
  next.stt.filterLowConfidence = f.filter.checked;
  next.keyPersist.stt = f.persist.checked;
  return next;
}

function clampNum(v, a, b, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d;
}

/** 授权确认 + 浏览器权限申请（在同一次点击手势内完成） */
async function ensureConsent(service, endpoint, purposeText, dataText) {
  const cur = S.consent[service];
  const granted = await chrome.permissions.contains({ origins: [originPattern(endpoint)] });
  if (consentValid(cur, endpoint) && granted) return true;
  const body = h(
    'div',
    null,
    h('p', { text: '请确认以下发送范围。确认后，日常一键流程不会再次询问；更换服务地址需要重新确认。' }),
    h('dl', null, h('dt', { text: '接收方' }), h('dd', { text: endpoint }), h('dt', { text: '发送内容' }), h('dd', { text: dataText }), h('dt', { text: '用途' }), h('dd', { text: purposeText }), h('dt', { text: '费用' }), h('dd', { text: '由该服务按其规则计费，可能产生费用。' })),
    h('p', { class: 'hint', text: '接下来浏览器会请求访问该地址的权限，用于发送请求（不会读取该网站的 Cookie 或页面）。' }),
  );
  if (!(await confirmDialog({ title: '确认发送授权', body, ok: '同意并授权' }))) return false;
  let ok = granted;
  if (!ok) {
    try {
      ok = await chrome.permissions.request({ origins: [originPattern(endpoint)] });
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    toast('浏览器权限未授予，未保存授权', 5000);
    return false;
  }
  return 'new';
}

async function saveCloudStt() {
  const next = readCloudSttForm();
  const ep = sttEndpoint(next.stt.baseUrl);
  if (!ep) return toast('请填写有效的 https 服务地址');
  if (!next.stt.model) return toast('请填写模型名');
  const keyInput = sttForm.key.value.trim();
  const existingKey = await getKey('stt', ep);
  if (!keyInput && !existingKey) return toast('请填写 API Key（地址变更后需要重新填写）', 5000);
  const c = await ensureConsent('stt', ep, '把录音转写为中文逐字稿', '当前录音音频（长音频分片多次发送）、模型名、语言与标点引导文字');
  if (!c) return;
  if (c === 'new') next.consent.stt = makeConsent(ep, 'transcribe');
  S = await saveSettings(next);
  if (keyInput) await setKey('stt', ep, keyInput, next.keyPersist.stt);
  else if (existingKey) await setKey('stt', ep, existingKey, next.keyPersist.stt); // 仅切换存储位置
  sttForm.key.value = '';
  refreshStatus();
  toast('转写服务已保存并授权');
}

async function testCloudStt() {
  const f = sttForm;
  const ep = sttEndpoint(f.base.value);
  if (!ep) return toast('请先填写有效的服务地址');
  const key = f.key.value.trim() || (await getKey('stt', ep));
  if (!key) return toast('请填写 API Key 再测试');
  await runTest(f.testOut, ep, async (signal) => {
    const r = await transcribeBlob({ endpoint: ep, key, model: f.model.value.trim(), language: f.lang.value.trim(), prompt: '', responseFormat: f.format.value, wavBlob: testToneWav(), timeoutMs: 30000, signal });
    return `连接成功：服务正常返回转写结果（测试音无语音，文字长度 ${r.text.length}${r.segments ? '，含分段信息' : ''}）。`;
  });
}

/** 运行一次可取消、有上限的连接测试 */
async function runTest(out, endpoint, fn) {
  const has = await chrome.permissions.contains({ origins: [originPattern(endpoint)] });
  if (!has) {
    let ok = false;
    try {
      ok = await chrome.permissions.request({ origins: [originPattern(endpoint)] });
    } catch {
      ok = false;
    }
    if (!ok) return toast('需要允许访问该地址才能测试');
  }
  const ctrl = new AbortController();
  const t0 = performance.now();
  out.replaceChildren(h('div', { class: 'notice acc' }, '正在测试…', h('button', { class: 'btn small ghost', text: '取消', onclick: () => ctrl.abort() })));
  try {
    const msg = await fn(ctrl.signal);
    out.replaceChildren(h('div', { class: 'notice ok', text: `${msg}（${Math.round(performance.now() - t0)} ms）` }));
  } catch (e) {
    const se = toSafeError(e);
    const d = se.diag || {};
    out.replaceChildren(h('div', { class: 'notice err', text: `${errText(se)}${d.status ? ` · HTTP ${d.status}` : ''}${d.contentType ? ` · ${d.contentType}` : ''}${d.length != null ? ` · ${d.length} 字节` : ''}` }));
  }
}

function localConfig() {
  const f = sttForm;
  f.lbase = h('input', { class: 'input', id: 'loc_base', type: 'url', value: S.local.baseUrl, placeholder: 'http://127.0.0.1:8765', spellcheck: 'false', autocomplete: 'off' });
  f.lmodel = h('input', { class: 'input', id: 'loc_model', value: S.local.model, placeholder: 'auto', spellcheck: 'false', autocomplete: 'off' });
  f.lkey = h('input', { class: 'input', id: 'loc_key', type: 'password', autocomplete: 'off', placeholder: '可选：服务要求时填写' });
  f.lpersist = h('input', { type: 'checkbox', checked: S.keyPersist.local });
  f.lendpoint = h('div', { class: 'endpoint' });
  f.ldiar = h('input', { type: 'checkbox', checked: S.local.diarize });
  f.lmb = h('input', { class: 'input', id: 'loc_mb', type: 'number', min: 10, max: 8192, value: S.local.maxUploadMB });
  f.lto = h('input', { class: 'input', id: 'loc_to', type: 'number', min: 60, max: 21600, value: S.local.timeoutSec });
  f.lstatus = h('div', { class: 'status-line' });
  f.status = f.lstatus;
  f.ltestOut = h('div', { class: 'test-out' });
  const updEp = () => {
    const ep = localEndpoint(f.lbase.value);
    f.lbase.classList.toggle('invalid', !!f.lbase.value && !ep);
    f.lendpoint.textContent = ep ? `请求地址：${ep}` : f.lbase.value ? '地址无效：只接受 http://127.0.0.1 或 http://localhost（可带端口与路径）' : '';
  };
  f.lbase.addEventListener('input', updEp);
  queueMicrotask(updEp);
  return [
    step(
      '② 配置本地服务',
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'loc_base', text: '本地服务地址' }),
        f.lbase,
        f.lendpoint,
        h('div', { class: 'hint', text: '支持任何兼容 OpenAI /audio/transcriptions 的本机服务（本插件自带后端、faster-whisper-server、LocalAI 等）。可填 http://127.0.0.1:端口（默认补 /v1/audio/transcriptions）、…/v1 或完整的 …/audio/transcriptions 地址。' }),
      ),
      h(
        'div',
        { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'loc_model', text: '模型' }), f.lmodel, h('div', { class: 'hint', text: '填该服务认可的模型名；本插件自带后端可填 auto（使用启动时加载的模型）。' })),
        h('div', { class: 'field' }, h('label', { for: 'loc_key', text: 'API Key（可选）' }), f.lkey, h('div', { class: 'hint', text: '大多数本地服务无需 Key；服务要求时填写，只发送到上面的本机地址。' })),
      ),
      h('label', { class: 'check' }, f.lpersist, h('span', null, h('b', { text: '在本机记住 Key' }), h('div', { class: 'hint', text: '不勾选则关闭浏览器后清除。' }))),
      h('label', { class: 'check' }, f.ldiar, h('span', null, h('b', { text: '可用时区分说话人' }), h('div', { class: 'hint', text: '仅本插件自带后端支持（需本地已安装说话人模型）；其他服务会忽略此选项，失败不影响普通转写。' }))),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'loc_mb', text: '单次处理上限（MB）' }), f.lmb), h('div', { class: 'field' }, h('label', { for: 'loc_to', text: '超时（秒）' }), f.lto)),
      h('div', { class: 'hint', text: '在上限内整段一次处理（说话人编号全程一致）；超过上限时自动分片，并不再做说话人分段。若你的服务有上传大小限制，请把上限调到不超过它。' }),
    ),
    step('③ 用途与授权', h('ul', { class: 'uses' }, h('li', { text: '发送：当前录音音频到你本机运行的服务，不经过网络。' }), h('li', { text: '是否下载或使用哪个模型，由你运行的本地服务决定。' })), f.lstatus),
    step(
      '④ 保存与测试',
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', text: '保存并授权', onclick: saveLocal }),
        h('button', { class: 'btn', text: '测试转写', onclick: testLocal }),
        h('button', { class: 'btn ghost', text: '撤销授权', onclick: () => revoke('local') }),
        h('button', { class: 'btn ghost', text: '清除 Key', onclick: async () => { await clearKey('local'); f.lkey.value = ''; refreshStatus(); toast('已清除 Key'); } }),
      ),
      h('p', { class: 'hint', text: '“测试转写”会向该地址发送一段 1.5 秒的固定测试音并走完整的转写请求，与正式转写完全一致；通过即可直接使用。' }),
      f.ltestOut,
    ),
  ];
}

function readLocalForm() {
  const f = sttForm;
  const next = structuredClone(S);
  next.local.baseUrl = f.lbase.value.trim();
  next.local.model = f.lmodel.value.trim() || 'auto';
  next.local.diarize = f.ldiar.checked;
  next.local.maxUploadMB = clampNum(f.lmb.value, 10, 8192, 2048);
  next.local.timeoutSec = clampNum(f.lto.value, 60, 21600, 3600);
  next.keyPersist.local = f.lpersist.checked;
  return next;
}

async function saveLocal() {
  const next = readLocalForm();
  const ep = localEndpoint(next.local.baseUrl);
  if (!ep) return toast('地址需为 http://127.0.0.1:端口 或 http://localhost:端口');
  const keyInput = sttForm.lkey.value.trim();
  const existingKey = await getKey('local', ep);
  const c = await ensureConsent('local', ep, '在本机把录音转写为逐字稿', '当前录音音频（仅发送到本机回环地址）、模型名、语言与标点引导文字');
  if (!c) return;
  if (c === 'new') next.consent.local = makeConsent(ep, 'transcribe');
  S = await saveSettings(next);
  if (keyInput) await setKey('local', ep, keyInput, next.keyPersist.local);
  else if (existingKey) await setKey('local', ep, existingKey, next.keyPersist.local); // 仅切换存储位置
  sttForm.lkey.value = '';
  refreshStatus();
  toast('本地服务已保存并授权');
}

async function testLocal() {
  const f = sttForm;
  const ep = localEndpoint(f.lbase.value);
  if (!ep) return toast('地址需为本机回环地址');
  const key = f.lkey.value.trim() || (await getKey('local', ep));
  const model = f.lmodel.value.trim() || 'auto';
  await runTest(f.ltestOut, ep, async (signal) => {
    const r = await transcribeBlob({ endpoint: ep, key, model, language: S.stt.language, prompt: '', responseFormat: 'verbose_json', wavBlob: testToneWav(), timeoutMs: 120000, signal, extraFields: { diarize: 'false' }, stage: 'local' });
    let extra = '';
    // 本插件自带后端提供 /health，可显示引擎信息；其他服务没有也不影响
    try {
      const hr = await requestText(`${new URL(ep).origin}/health`, { method: 'GET' }, { timeoutMs: 3000, signal, stage: 'local' });
      const j = hr.status === 200 ? JSON.parse(hr.text) : null;
      if (j && j.engine) extra = `；识别引擎 ${j.engine}${j.model ? `（${j.model}）` : ''}${typeof j.diarization === 'boolean' ? `；说话人区分：${j.diarization ? '可用' : '不可用'}` : ''}`;
    } catch {
      /* 可选信息 */
    }
    return `转写成功：本地服务正常返回结果（测试音无语音，文字长度 ${r.text.length}${r.segments ? '，含分段信息' : ''}）${extra}。`;
  });
}

async function revoke(service) {
  const next = structuredClone(S);
  const ep = serviceEndpoint(S, service);
  next.consent[service] = null;
  S = await saveSettings(next);
  if (ep) {
    const pattern = originPattern(ep);
    const others = ['stt', 'local', 'llm'].filter((x) => x !== service && S.consent[x]).map((x) => originPattern(S.consent[x].endpoint));
    if (!others.includes(pattern)) await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
  }
  refreshStatus();
  toast('已撤销授权；不会再向该服务发送数据');
}

// ---------- 笔记模型 ----------
const llmForm = {};
function llmSection() {
  const f = llmForm;
  f.base = h('input', { class: 'input', id: 'llm_base', type: 'url', value: S.llm.baseUrl, placeholder: 'https://api.example.com/v1', spellcheck: 'false', autocomplete: 'off' });
  f.model = h('input', { class: 'input', id: 'llm_model', value: S.llm.model, spellcheck: 'false', autocomplete: 'off' });
  f.key = h('input', { class: 'input', id: 'llm_key', type: 'password', autocomplete: 'off', placeholder: '粘贴 API Key' });
  f.persist = h('input', { type: 'checkbox', checked: S.keyPersist.llm });
  f.endpoint = h('div', { class: 'endpoint' });
  f.maxIn = h('input', { class: 'input', id: 'llm_in', type: 'number', min: 1000, max: 2000000, value: S.llm.maxInputChars });
  f.maxOut = h('input', { class: 'input', id: 'llm_out', type: 'number', min: 256, max: 200000, value: S.llm.maxOutputTokens });
  f.timeout = h('input', { class: 'input', id: 'llm_to', type: 'number', min: 30, max: 1800, value: S.llm.timeoutSec });
  f.temp = h('input', { class: 'input', id: 'llm_temp', type: 'number', min: 0, max: 2, step: 0.1, value: S.llm.temperature });
  f.status = h('div', { class: 'status-line' });
  f.testOut = h('div', { class: 'test-out' });
  const updEp = () => {
    const ep = llmEndpoint(f.base.value);
    f.base.classList.toggle('invalid', !!f.base.value && !ep);
    f.endpoint.textContent = ep ? `请求地址：${ep}` : f.base.value ? '地址无效：需要 https://' : '';
  };
  f.base.addEventListener('input', updEp);
  queueMicrotask(updEp);
  const presets = h('div', { class: 'presets' }, h('span', { class: 'hint', text: '示例（模型名请以服务商文档为准）：' }), LLM_PRESETS.map((p) => h('button', { class: 'btn small', text: p.name, onclick: () => { f.base.value = p.baseUrl; f.model.value = p.model; updEp(); } })));
  return section(
    'llm',
    '笔记模型（LLM）',
    '与转写服务独立配置。使用非流式 Chat Completions 接口，把有效逐字稿整理为学习笔记。',
    step('① 配置服务', presets, h('div', { class: 'field' }, h('label', { for: 'llm_base', text: '服务地址' }), f.base, f.endpoint, h('div', { class: 'hint', text: '可填 https://host/v1、带末尾斜杠，或完整的 …/chat/completions；请对照上方“请求地址”确认。' })), h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'llm_model', text: '模型' }), f.model), h('div', { class: 'field' }, h('label', { for: 'llm_key', text: 'API Key' }), f.key)), h('label', { class: 'check' }, f.persist, h('span', null, h('b', { text: '在本机记住 Key' }), h('div', { class: 'hint', text: '默认只保存在本次浏览器会话中。' }))), h('details', null, h('summary', { text: '高级：限额与参数' }), h('div', { class: 'grid-2', style: 'margin-top:.8rem' }, h('div', { class: 'field' }, h('label', { for: 'llm_in', text: '最大输入字数' }), f.maxIn), h('div', { class: 'field' }, h('label', { for: 'llm_out', text: '最大输出 tokens' }), f.maxOut), h('div', { class: 'field' }, h('label', { for: 'llm_to', text: '超时（秒）' }), f.timeout), h('div', { class: 'field' }, h('label', { for: 'llm_temp', text: 'temperature' }), f.temp)), h('div', { class: 'hint', text: '逐字稿超过最大输入字数时会提示并停止，不会静默截断。' }))),
    step('② 用途与授权', h('ul', { class: 'uses' }, h('li', { text: '发送：当前材料的有效逐字稿与固定的整理提示词。' }), h('li', { text: '不发送：网页标题、网址、音频、账号或其他材料。' }), h('li', { text: '用途：生成精简/详细/纪要笔记。费用由服务商按其规则计费。' })), f.status),
    step('③ 保存与测试', h('div', { class: 'actions' }, h('button', { class: 'btn primary', text: '保存并授权', onclick: saveLlm }), h('button', { class: 'btn', text: '测试连接', onclick: testLlm }), h('button', { class: 'btn ghost', text: '撤销授权', onclick: () => revoke('llm') }), h('button', { class: 'btn ghost', text: '清除 Key', onclick: async () => { await clearKey('llm'); f.key.value = ''; refreshStatus(); toast('已清除 Key'); } })), h('p', { class: 'hint', text: '“测试连接”只发送一句固定的测试消息，不使用你的任何逐字稿。' }), f.testOut),
  );
}

async function saveLlm() {
  const f = llmForm;
  const next = structuredClone(S);
  next.llm.baseUrl = f.base.value.trim();
  next.llm.model = f.model.value.trim();
  next.llm.maxInputChars = clampNum(f.maxIn.value, 1000, 2000000, 60000);
  next.llm.maxOutputTokens = clampNum(f.maxOut.value, 256, 200000, 4096);
  next.llm.timeoutSec = clampNum(f.timeout.value, 30, 1800, 240);
  next.llm.temperature = clampNum(f.temp.value, 0, 2, 0.3);
  next.keyPersist.llm = f.persist.checked;
  const ep = llmEndpoint(next.llm.baseUrl);
  if (!ep) return toast('请填写有效的 https 服务地址');
  if (!next.llm.model) return toast('请填写模型名');
  const keyInput = f.key.value.trim();
  const existingKey = await getKey('llm', ep);
  if (!keyInput && !existingKey) return toast('请填写 API Key（地址变更后需要重新填写）', 5000);
  const c = await ensureConsent('llm', ep, '把逐字稿整理为学习笔记', '当前材料的有效逐字稿与固定提示词');
  if (!c) return;
  if (c === 'new') next.consent.llm = makeConsent(ep, 'notes');
  S = await saveSettings(next);
  await setKey('llm', ep, keyInput || existingKey, next.keyPersist.llm);
  f.key.value = '';
  refreshStatus();
  toast('笔记模型已保存并授权');
}

async function testLlm() {
  const f = llmForm;
  const ep = llmEndpoint(f.base.value);
  if (!ep) return toast('请先填写有效的服务地址');
  const key = f.key.value.trim() || (await getKey('llm', ep));
  if (!key) return toast('请填写 API Key 再测试');
  await runTest(f.testOut, ep, async (signal) => {
    const r = await chatComplete({ endpoint: ep, key, model: f.model.value.trim(), messages: LLM_TEST_MESSAGES, maxTokens: 512, temperature: 0, timeoutMs: 45000, signal });
    return `连接成功：模型 ${r.model || f.model.value.trim()} 返回了 ${r.content.length} 个字符。`;
  });
}

// ---------- 状态行 ----------
async function refreshStatus() {
  const sttLine = sttForm.status;
  if (sttLine) {
    if (S.stt.provider === 'local') {
      const ep = localEndpoint(S.local.baseUrl);
      sttLine.replaceChildren(...(await statusChips('local', ep, 'optional')));
    } else {
      const ep = sttEndpoint(S.stt.baseUrl);
      sttLine.replaceChildren(...(await statusChips('stt', ep, true)));
    }
  }
  if (llmForm.status) llmForm.status.replaceChildren(...(await statusChips('llm', llmEndpoint(S.llm.baseUrl), true)));
}

async function statusChips(service, ep, needsKey) {
  const out = [];
  if (!ep) return [h('span', { class: 'chip', text: '尚未配置' })];
  const consent = S.consent[service];
  const perm = await chrome.permissions.contains({ origins: [originPattern(ep)] }).catch(() => false);
  if (consentValid(consent, ep)) out.push(h('span', { class: 'chip ok', text: `已授权 · ${fmtTime(consent.grantedAt)}` }));
  else if (consent) out.push(h('span', { class: 'chip warn', text: '地址已变更，需要重新授权' }));
  else out.push(h('span', { class: 'chip warn', text: '未授权' }));
  out.push(h('span', { class: `chip ${perm ? 'ok' : 'warn'}`, text: perm ? '浏览器权限已允许' : '浏览器权限未允许' }));
  if (needsKey) {
    const k = await hasStoredKey(service);
    const bound = k.exists && k.endpoint === ep;
    if (bound) out.push(h('span', { class: 'chip ok', text: k.persisted ? 'Key 已记住在本机' : 'Key 仅本次会话' }));
    else if (needsKey === 'optional') out.push(h('span', { class: 'chip', text: '未填写 Key（可选）' }));
    else out.push(h('span', { class: 'chip warn', text: 'Key 未保存' }));
  }
  return out;
}

// ---------- 字幕 ----------
function subtitleSection() {
  return section(
    'subtitle',
    'B站字幕',
    '在 B站视频页开始任务时自动先尝试完整字幕；不可用或不符合下列策略时，同一任务自动转为录音，无需再次点击。',
    toggle('subtitle.enabled', '字幕优先', '关闭后 B站也直接录音转写。'),
    toggle('subtitle.acceptAuto', '采用自动生成（AI）字幕', '关闭则只采用人工字幕，其他情况自动录音。'),
    toggle('subtitle.acceptUnknown', '采用来源无法确定的字幕', '接口未明确标注时显示为“来源未知”，不会冒充人工字幕。'),
    toggle('subtitle.allowNonChinese', '没有中文字幕时采用其他语言字幕', '默认关闭：没有中文字幕时改为录音转写为中文。'),
    toggle('subtitle.useLogin', '允许使用当前浏览器的 B站登录状态获取字幕', '部分字幕需要登录才能获取。开启后，字幕请求由 B站页面以你的登录状态发起（与网页自身请求相同）；插件不读取、复制或保存 Cookie，也不会把登录状态带到其他网站或模型服务。'),
    numberField('subtitle.timeoutSec', '字幕获取最长等待', { min: 4, max: 60, unit: '秒', hint: '超时后自动转为录音。' }),
  );
}

// ---------- 录音与自动处理 ----------
function recordSection() {
  const mode = h('div', { class: 'seg', role: 'group', 'aria-label': '自动笔记模式' });
  for (const [k, v] of Object.entries(NOTE_MODES)) mode.append(h('button', { 'aria-pressed': String(S.note.mode === k), title: v.hint, text: v.label, onclick: async () => { await setPath('note.mode', k); mode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === v.label))); } }));
  return section(
    'record',
    '录音与自动处理',
    '录音只录制你授权的标签页实际发出的声音。',
    toggle('record.monitor', '录音时同时听声音', '默认静音监听（录音不受影响）；录制中也可在弹窗或浮窗切换。'),
    toggle('record.pauseOnStop', '手动停止时同时暂停网页视频'),
    toggle('record.autoTranscribe', '正常播完后自动转写', '关闭后只保存音频，可稍后在材料页转写。'),
    toggle('record.transcribeAfterManualStop', '手动“停止并保存”后也自动转写', '异常中断的录音永远不会自动上传。'),
    step('笔记', toggle('note.auto', '逐字稿保存后自动生成笔记', '需要先配置笔记模型。'), h('div', { class: 'field' }, h('span', { class: 'label', text: '默认笔记模式' }), mode), toggle('note.ignorePromo', '笔记中忽略一般商业推广', '只影响笔记，不改动逐字稿；与主题相关的产品事实会保留。')),
  );
}

// ---------- 浮窗与快捷键 ----------
function shortcutSection() {
  const list = h('ul', { class: 'uses' });
  chrome.commands.getAll().then((cmds) => {
    for (const c of cmds) if (c.description) list.append(h('li', null, c.description, '：', c.shortcut ? h('span', { class: 'keycap', text: c.shortcut }) : h('span', { class: 'hint', text: '未设置' })));
  });
  const keyInput = h('input', { class: 'input', id: 'hotkey', value: S.float.hotkey, readonly: true, style: 'max-width:8rem', 'aria-describedby': 'hotkey_hint' });
  keyInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return toast('请按一个单独的字符键（如 ` 或 ;）');
    keyInput.value = e.key;
    await setPath('float.hotkey', e.key);
  });
  return section(
    'shortcut',
    '浮窗、快捷键与通知',
    '',
    h('p', { class: 'hint', text: '浏览器快捷键（在任何页面都可用，也满足浏览器对录音的授权要求）：' }),
    list,
    h('button', { class: 'btn small', text: '修改浏览器快捷键', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }),
    step('网页浮窗', toggle('float.enabled', '在 B站、YouTube、抖音页面显示浮窗', '浮窗与工具栏执行同一任务和流程（含 B站字幕优先）。隐藏浮窗不影响任务。'), toggle('float.hotkeyEnabled', '启用站内单键呼出浮窗', '在输入框、评论区和输入法输入时不会响应。'), h('div', { class: 'field' }, h('label', { for: 'hotkey', text: '单键' }), keyInput, h('div', { class: 'hint', id: 'hotkey_hint', text: '点击输入框后按下想用的键。' })), h('p', { class: 'hint', text: '提示：浏览器只允许在你通过工具栏图标或浏览器快捷键启动过扩展的页面录制声音。若从浮窗开始且需要录音，首次可能需要点一下工具栏图标完成授权。' })),
    step('通知', toggle('notify.enabled', '完成或失败时显示系统通知')),
  );
}

// ---------- 存储与外观 ----------
function storageSection() {
  const usage = h('div', { class: 'hint' }, '计算中…');
  totalAudioBytes().then((b) => (usage.textContent = `当前音频缓存 ${fmtBytes(b)} / 约 ${fmtBytes(AUDIO_CACHE_LIMIT)}。接近上限时，在开始或结束任务时自动清理最旧的已转写音频（逐字稿、笔记与记录保留）；正在录制或处理的材料不会被清理。`));
  const theme = h('select', { class: 'input', id: 'theme', style: 'max-width:12rem' }, [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, l]) => h('option', { value: v, text: l, selected: S.ui.theme === v })));
  theme.addEventListener('change', () => setPath('ui.theme', theme.value));
  // 界面比例：自动适配（平台 × 实测字形）基础上的微调，拖动时实时预览
  const SC = globalThis.WV4UScale;
  const pct = SC.userPercent(S.ui);
  const scaleOut = h('output', { for: 'ui_scale', class: 'scale-out', text: `${pct}%` });
  const scaleInfo = h('div', { class: 'hint', id: 'ui_scale_info' });
  const describe = (ui) => {
    const r = SC.compute({ ui });
    const osName = { windows: 'Windows', mac: 'macOS', linux: 'Linux', chromeos: 'ChromeOS' }[r.os] || '其他系统';
    const dpr = Math.round((globalThis.devicePixelRatio || 1) * 100);
    scaleInfo.textContent = `自动适配：${osName} 基准 ${Math.round(r.base * 100)}% × 中文字形校正 ${Math.round(r.fontFactor * 100)}% × 你的微调 ${r.user}% = 实际 ${Math.round(r.scale * 100)}%（正文约 ${(parseFloat(getComputedStyle(document.body).fontSize) || 0).toFixed(1)}px；设备像素比 ${dpr}%）。`;
  };
  const scale = h('input', { type: 'range', id: 'ui_scale', class: 'range', min: String(SC.USER_MIN), max: String(SC.USER_MAX), step: '5', value: String(pct), 'aria-describedby': 'ui_scale_info' });
  scale.addEventListener('input', () => {
    scaleOut.textContent = `${scale.value}%`;
    SC.applyRoot({ scale: Number(scale.value) });
    describe({ scale: Number(scale.value) });
  });
  scale.addEventListener('change', () => setPath('ui.scale', Number(scale.value)));
  const reset = h('button', { class: 'btn small ghost', type: 'button', text: '恢复 100%', onclick: () => { scale.value = '100'; scale.dispatchEvent(new Event('input')); setPath('ui.scale', 100); } });
  requestAnimationFrame(() => describe(S.ui));
  return section(
    'storage',
    '存储与外观',
    '材料只保存在本机浏览器中。',
    usage,
    h('div', { class: 'grid-2', style: 'margin-top:1rem' }, h('div', { class: 'field' }, h('label', { for: 'theme', text: '主题' }), theme), h('div', { class: 'field' }, h('label', { for: 'ui_scale', text: '界面比例' }), h('div', { class: 'row scale-row' }, scale, scaleOut, reset), scaleInfo, h('div', { class: 'hint', text: '界面会按系统自动适配：Windows / Linux 使用更紧凑的字号阶梯和常规字重，并按实际中文字体的字面大小校正。这里只需在此基础上微调；作用于弹窗、材料页、设置页与网页浮窗，浏览器自身的缩放与字号设置仍然生效。' }))),
  );
}

// ---------- 诊断 ----------
let diagBox = null;
function diagSection() {
  diagBox = h('div', { class: 'diag-wrap' });
  renderDiagTable();
  return section(
    'diag',
    '诊断（低频）',
    '只读记录 YouTube 的广告/正文/未知状态与结束判断，帮助排查。只保存在本机、最多 300 条，不包含标题、网址或任何私密内容，不影响录音。',
    toggle('diag.youtube', '记录 YouTube 播放判定'),
    h('div', { class: 'actions' }, h('button', { class: 'btn small', text: '导出', onclick: async () => { const r = await chrome.storage.local.get('diag.youtube'); downloadBlob(new Blob([JSON.stringify(r['diag.youtube'] || [], null, 2)], { type: 'application/json' }), 'WatchVid4U-诊断.json'); } }), h('button', { class: 'btn small ghost', text: '清除', onclick: async () => { await chrome.storage.local.remove('diag.youtube'); renderDiagTable(); toast('已清除'); } })),
    diagBox,
  );
}

async function renderDiagTable() {
  if (!diagBox) return;
  const r = await chrome.storage.local.get('diag.youtube');
  const list = (r['diag.youtube'] || []).slice(-100).reverse();
  if (!list.length) return diagBox.replaceChildren(h('p', { class: 'hint', text: '暂无记录。' }));
  diagBox.replaceChildren(h('table', { class: 'diag-table' }, h('thead', null, h('tr', null, ['时间', '事件', '状态', '进度', '时长'].map((t) => h('th', { text: t })))), h('tbody', null, list.map((e) => h('tr', null, h('td', { text: new Date(e.t).toLocaleTimeString() }), h('td', { text: e.event }), h('td', { text: e.state }), h('td', { text: e.ct ?? '' }), h('td', { text: e.dur ?? '' }))))));
}

// ---------- 隐私 ----------
function privacySection() {
  return section(
    'privacy',
    '隐私说明',
    '',
    h(
      'div',
      { class: 'privacy' },
      h('ul', null, h('li', { text: '没有项目方服务器、代理、统计或后台数据收集。材料、音频、逐字稿和笔记只保存在本机浏览器。' }), h('li', { text: '只有你授权的转写/笔记服务会收到数据：转写服务只收到当前录音音频与必要参数；笔记服务只收到当前有效逐字稿与固定提示词。网页标题、网址、账号信息从不发送。' }), h('li', { text: '录音只针对你启动任务的标签页；网页本身无法通过插件读取材料、Key 或让插件访问任意地址。' }), h('li', { text: '不下载视频、不使用 yt-dlp、不读取 Cookie 值、不绕过登录、签名、DRM 或访问限制。' }), h('li', { text: 'Key 默认只保存在本次浏览器会话；“记住在本机”时以未加密形式存于扩展数据中。清除 Key、撤销授权、删除材料三者互相独立。' })),
    ),
  );
}
