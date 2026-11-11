import { test, describe, assert } from './harness.js';
import { detectOS, validateServiceUrl, sttEndpoint, llmEndpoint, localEndpoint, consentValid, makeConsent, applySettingsChange, normalizeSettings, sliceSeconds, readiness, originPattern, sttTarget } from '../../extension/src/shared/settings.js';

describe('settings', () => {
  test('URL 校验：https 允许、http 仅回环、拒绝带凭据', () => {
    assert.ok(validateServiceUrl('https://api.groq.com/openai/v1').ok);
    assert.ok(validateServiceUrl('http://127.0.0.1:8765').ok);
    assert.ok(validateServiceUrl('http://localhost:8765').ok);
    assert.equal(validateServiceUrl('http://api.example.com/v1').ok, false);
    assert.equal(validateServiceUrl('https://user:pw@api.example.com').ok, false);
    assert.equal(validateServiceUrl('ftp://x').ok, false);
    assert.equal(validateServiceUrl('').ok, false);
  });
  test('转写端点规范化', () => {
    assert.equal(sttEndpoint('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(sttEndpoint('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(sttEndpoint('https://x.com/v1/audio/transcriptions'), 'https://x.com/v1/audio/transcriptions');
    assert.equal(sttEndpoint('http://evil.com/v1'), null);
  });
  test('LLM 端点兼容 MiMo 等常见写法', () => {
    assert.equal(llmEndpoint('https://api.xiaomimimo.com/v1'), 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(llmEndpoint('https://api.xiaomimimo.com/v1/'), 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(llmEndpoint('https://api.xiaomimimo.com/v1/chat/completions'), 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(llmEndpoint(' https://api.deepseek.com '), 'https://api.deepseek.com/chat/completions');
  });
  test('本地端点只接受回环', () => {
    assert.equal(localEndpoint('http://127.0.0.1:8765'), 'http://127.0.0.1:8765/v1/audio/transcriptions');
    assert.equal(localEndpoint('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765/v1/audio/transcriptions');
    assert.equal(localEndpoint('http://localhost:8000/v1'), 'http://localhost:8000/v1/audio/transcriptions');
    assert.equal(localEndpoint('http://localhost:9000/api/v1/audio/transcriptions'), 'http://localhost:9000/api/v1/audio/transcriptions');
    assert.equal(localEndpoint('https://example.com'), null);
    assert.equal(localEndpoint('http://192.168.1.2:8000'), null);
  });
  test('本地服务：Key 可选且换地址清除旧 Key', () => {
    const s = normalizeSettings({ stt: { provider: 'local' }, local: { baseUrl: 'http://127.0.0.1:8765' } });
    const t = sttTarget(s);
    assert.equal(t.keyService, 'local');
    assert.equal(t.needsKey, false);
    assert.equal(s.keyPersist.local, true, 'Key 默认记住在本机');
    const r = applySettingsChange(s, { ...s, local: { ...s.local, baseUrl: 'http://127.0.0.1:8000/v1' } });
    assert.deepEqual(r.clearKeys, ['local']);
    const c = { ...t, consent: makeConsent(t.endpoint, 'x') };
    assert.ok(readiness(c, '', true).ok, '不填 Key 也就绪');
  });
  test('授权只绑定端点：换模型不失效，换地址失效', () => {
    const ep = sttEndpoint('https://api.groq.com/openai/v1');
    const s = normalizeSettings({ stt: { baseUrl: 'https://api.groq.com/openai/v1', model: 'a' }, consent: { stt: makeConsent(ep, 'transcribe') } });
    assert.ok(consentValid(s.consent.stt, sttTarget(s).endpoint));
    const r1 = applySettingsChange(s, { ...s, stt: { ...s.stt, model: 'b' } });
    assert.ok(consentValid(r1.settings.consent.stt, ep), '换模型后仍有效');
    assert.deepEqual(r1.clearKeys, []);
    const r2 = applySettingsChange(s, { ...s, stt: { ...s.stt, baseUrl: 'https://api.openai.com/v1' } });
    assert.equal(r2.settings.consent.stt, null, '换地址撤销授权');
    assert.deepEqual(r2.clearKeys, ['stt'], '换地址清除旧 Key');
  });
  test('分片时长受上传上限约束', () => {
    assert.equal(sliceSeconds(25, 10), 600);
    assert.equal(sliceSeconds(1, 10), Math.floor((1048576 * 0.95 - 44) / 32000));
    assert.ok(sliceSeconds(25, 10) * 32000 + 44 < 25 * 1048576);
  });
  test('就绪判断按顺序报告缺失项', () => {
    const t = { endpoint: 'https://a.com/x', needsKey: true, consent: null };
    assert.equal(readiness({ ...t, endpoint: null }, '', false).code, 'not_configured');
    assert.equal(readiness(t, 'k', true).code, 'consent_missing');
    const c = { ...t, consent: makeConsent('https://a.com/x', 'x') };
    assert.equal(readiness(c, 'k', false).code, 'permission_missing');
    assert.equal(readiness(c, '', true).code, 'key_missing');
    assert.ok(readiness(c, 'k', true).ok);
  });
  test('权限模式只到主机级', () => {
    assert.equal(originPattern('http://127.0.0.1:8765/v1/audio/transcriptions'), 'http://127.0.0.1/*');
    assert.equal(originPattern('https://api.groq.com/openai/v1/audio/transcriptions'), 'https://api.groq.com/*');
  });
  test('旧设置缺字段时补默认值且保留授权', () => {
    const s = normalizeSettings({ stt: { model: 'm' }, consent: { llm: { endpoint: 'e', version: 1 } } });
    assert.equal(s.stt.model, 'm');
    assert.equal(s.stt.maxUploadMB, 25);
    assert.equal(s.consent.llm.endpoint, 'e');
    assert.equal(s.consent.stt, null);
  });
  test('尺寸自适应：平台基准 × 字形校正 × 用户微调', () => {
    const SC = globalThis.WV4UScale;
    assert.equal(detectOS({ userAgentData: { platform: 'Windows' } }), 'windows');
    assert.equal(SC.detectOS({ platform: 'Win32' }), 'windows');
    assert.equal(SC.detectOS({ platform: 'MacIntel' }), 'mac');
    // 参考字体（苹方）字面：mac 保持 1
    assert.equal(SC.compute({ os: 'mac', face: SC.REF_FACE, ui: {} }).scale, 1);
    assert.equal(SC.compute({ os: 'windows', face: SC.REF_FACE, ui: {} }).scale, 0.875);
    // 字面更大的字体（如雅黑）按比例缩小，但有下限
    const big = SC.compute({ os: 'windows', face: SC.REF_FACE / 0.94, ui: {} });
    assert.equal(big.fontFactor, 0.94);
    assert.equal(big.scale, 0.823);
    assert.equal(SC.faceFactor(5), 1, '异常测量值不校正');
    assert.equal(SC.faceFactor(SC.REF_FACE / 0.8), 0.86, '校正有下限');
    // 用户微调与旧设置迁移
    assert.equal(SC.compute({ os: 'mac', face: SC.REF_FACE, ui: { scale: 110 } }).scale, 1.1);
    assert.equal(SC.userPercent({ density: 'compact' }), 90);
    assert.equal(SC.userPercent({ density: 'large' }), 112.5);
    assert.equal(SC.userPercent({ scale: 300 }), 125);
    // 本机实测：当前字体栈的字面应接近参考字体
    const face = SC.measureFace();
    assert.ok(face > 0.6 && face < 1.1, String(face));
  });
});
