import { test, describe, assert } from './harness.js';
import { chatComplete, stripThink, unwrapFence } from '../../extension/src/shared/llm.js';

const base = `${location.origin}/mock`;
const call = (variant, extra = {}) => chatComplete({ endpoint: `${base}/${variant}/v1/chat/completions`, key: 'sk-test', model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, temperature: 0, timeoutMs: 5000, ...extra });

describe('llm client', () => {
  test('正常：非流式请求，去掉思考过程与外层代码围栏', async () => {
    await fetch(`${base}/reset`);
    const r = await call('llm');
    assert.ok(r.content.startsWith('# 测试笔记'));
    assert.notMatch(r.content, /think|```/);
    const log = await (await fetch(`${base}/log`)).json();
    assert.equal(log.find((x) => x.kind === 'llm').stream, false);
  });
  test('网页响应', () => assert.rejectsCode(call('llm-html'), 'html_response'));
  test('意外流式响应', () => assert.rejectsCode(call('llm-stream'), 'unexpected_stream'));
  test('空响应', () => assert.rejectsCode(call('llm-empty'), 'empty_response'));
  test('无效 JSON', () => assert.rejectsCode(call('llm-badjson'), 'invalid_json'));
  test('输出被截断', () => assert.rejectsCode(call('llm-length'), 'incomplete_output'));
  test('内容为空', () => assert.rejectsCode(call('llm-nocontent'), 'empty_content'));
  test('5xx', () => assert.rejectsCode(call('llm-500'), 'http_server'));
  test('401 且错误说明中的 Key 被脱敏', async () => {
    const e = await assert.rejectsCode(call('llm-401'), 'http_auth');
    assert.notMatch(e.detail, /sk-abcdefghijklmnop/);
    assert.equal(e.diag.status, 401);
    assert.ok(!('body' in e.diag));
  });
  test('辅助：think 与 fence', () => {
    assert.equal(stripThink('<think>x</think>\n答'), '答');
    assert.equal(unwrapFence('```md\n# a\n```'), '# a');
    assert.equal(unwrapFence('# a\n```js\nx\n```'), '# a\n```js\nx\n```');
  });
});
