// 非流式 Chat Completions 客户端，细分各类异常。
import { AppError } from './errors.js';
import { requestText, throwForStatus, parseJsonBody, shortType } from './http.js';

export async function chatComplete({ endpoint, key, model, messages, maxTokens, temperature, timeoutMs, signal }) {
  const body = { model, messages, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  if (typeof temperature === 'number') body.temperature = temperature;
  const r = await requestText(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    },
    { timeoutMs, signal, stage: 'llm' },
  );
  throwForStatus(r, 'llm');
  return parseChatResponse(r);
}

/** 解析 2xx 响应；单独导出以便测试 */
export function parseChatResponse(r) {
  const j = parseJsonBody(r, 'llm');
  const diag = { status: r.status, contentType: shortType(r.contentType), length: r.text.length };
  if (j && j.error) throw new AppError('http_other', { stage: 'llm', diag, detail: String(j.error.message || j.error.code || '').slice(0, 160) });
  const choice = j && Array.isArray(j.choices) ? j.choices[0] : null;
  if (!choice) throw new AppError('unexpected_shape', { stage: 'llm', diag });
  let content = choice.message ? choice.message.content : choice.text;
  if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('');
  if (typeof content !== 'string') content = '';
  content = stripThink(content).trim();
  if (choice.finish_reason === 'length') throw new AppError('incomplete_output', { stage: 'llm', diag: { ...diag, finish: 'length', outLength: content.length } });
  if (!content) throw new AppError('empty_content', { stage: 'llm', diag: { ...diag, finish: String(choice.finish_reason || '') } });
  return { content: unwrapFence(content), model: j.model || null, usage: j.usage || null };
}

/** 部分推理模型会把思考过程放在 <think> 中；笔记只保留正式输出 */
export function stripThink(s) {
  return s.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

/** 模型偶尔用 ```markdown 包裹整篇输出，去掉外层围栏 */
export function unwrapFence(s) {
  const m = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return m ? m[1] : s;
}
