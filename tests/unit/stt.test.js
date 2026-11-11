import { test, describe, assert } from './harness.js';
import { transcribeBlob, filterSegments, joinTexts, buildSlicePrompt } from '../../extension/src/shared/stt.js';
import { testToneWav } from '../../extension/src/shared/wav.js';

const base = `${location.origin}/mock`;
const call = (variant, extra = {}) => transcribeBlob({ endpoint: `${base}/${variant}/v1/audio/transcriptions`, key: 'test-key', model: 'm', language: 'zh', prompt: 'p', responseFormat: 'verbose_json', wavBlob: testToneWav(2), timeoutMs: 5000, ...extra });

describe('stt client', () => {
  test('正常 verbose_json：返回文本与分段', async () => {
    await fetch(`${base}/reset`);
    const r = await call('stt');
    assert.match(r.text, /第1片第1句/);
    assert.ok(Array.isArray(r.segments) && r.segments.length === 1);
    const log = await (await fetch(`${base}/log`)).json();
    const e = log.find((x) => x.kind === 'stt');
    assert.deepEqual(e.fields, ['language', 'model', 'prompt', 'response_format', 'temperature'], '只发送音频与必要参数');
    assert.ok(e.auth);
    assert.ok(Math.abs(e.duration - 2) < 0.01);
  });
  test('413 识别为服务商上传上限', () => call('stt-413').then(() => { throw new Error('should fail'); }, (e) => assert.equal(e.code, 'http_too_large')));
  test('返回网页识别为 html_response', () => assert.rejectsCode(call('stt-html'), 'html_response'));
  test('超时与取消区分', async () => {
    await assert.rejectsCode(call('stt-slow', { timeoutMs: 300 }), 'timeout');
    const c = new AbortController();
    setTimeout(() => c.abort(), 200);
    await assert.rejectsCode(call('stt-slow', { signal: c.signal }), 'cancelled');
  });
  test('本地服务 403 单独报错，并提取 FastAPI detail 说明', async () => {
    const e = await call('stt-403-detail', { stage: 'local' }).then(() => null, (x) => x);
    assert.equal(e.code, 'local_http_auth');
    assert.equal(e.stage, 'local');
    assert.equal(e.detail, 'origin denied');
    await assert.rejectsCode(call('stt-403-detail'), 'http_auth');
  });
  test('本地服务：未填模型时发送 auto，填了 Key 就带 Authorization', async () => {
    await fetch(`${base}/reset`);
    await call('stt', { model: '', stage: 'local' });
    const log = await (await fetch(`${base}/log`)).json();
    const e = log.find((x) => x.kind === 'stt');
    assert.equal(e.model, 'auto');
    assert.ok(e.auth);
  });
  test('本地服务连不上时提示检查本地服务', () => assert.rejectsCode(transcribeBlob({ endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions', key: '', model: 'm', responseFormat: 'json', wavBlob: testToneWav(1), timeoutMs: 3000, stage: 'local' }), 'local_network'));
  test('网络错误', () => assert.rejectsCode(transcribeBlob({ endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions', key: '', model: 'm', responseFormat: 'json', wavBlob: testToneWav(1), timeoutMs: 3000 }), 'network'));
  test('置信度过滤：只按模型信号，不按内容关键词', () => {
    const segs = [
      { text: '正常', no_speech_prob: 0.1, avg_logprob: -0.3 },
      { text: '请不吝点赞订阅', no_speech_prob: 0.9, avg_logprob: -1.5 },
      { text: '请不吝点赞订阅', no_speech_prob: 0.1, avg_logprob: -0.2 },
      { text: '重复重复重复', compression_ratio: 3, avg_logprob: -1.2 },
    ];
    const r = filterSegments(segs, true);
    assert.equal(r.dropped, 2);
    assert.deepEqual(r.segments.map((s) => s.text), ['正常', '请不吝点赞订阅']);
    assert.equal(filterSegments(segs, false).dropped, 0);
  });
  test('拼接：中文不加空格，英文单词间加空格', () => {
    assert.equal(joinTexts(['你好。', '世界']), '你好。世界');
    assert.equal(joinTexts(['hello', 'world']), 'hello world');
    assert.equal(joinTexts(['  ', 'a']), 'a');
  });
  test('分片 prompt 带上一片末尾上下文', () => {
    const p = buildSlicePrompt('引导', 'x'.repeat(300) + '结尾句。');
    assert.ok(p.startsWith('引导\n'));
    assert.ok(p.endsWith('结尾句。'));
    assert.ok(p.length <= 3 + 120);
  });
});
