// 带超时与取消的请求，以及对响应的细分类。诊断信息只包含状态码、内容类型与长度。
import { AppError } from './errors.js';

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{timeoutMs:number, signal?:AbortSignal, stage:string}} opt
 * @returns {Promise<{status:number, contentType:string, text:string}>}
 */
export async function requestText(url, init, { timeoutMs, signal, stage }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw new AppError('timeout', { stage, diag: { type: 'timeout', ms: timeoutMs } });
    if (signal?.aborted) throw new AppError('cancelled', { stage });
    throw new AppError(stage === 'local' ? 'local_network' : 'network', { stage, diag: { type: 'network' } });
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  let text;
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw new AppError('timeout', { stage, diag: { type: 'timeout_body', status: res.status } });
    if (signal?.aborted) throw new AppError('cancelled', { stage });
    throw new AppError('body_read_failed', { stage, diag: { status: res.status, contentType: shortType(contentType) } });
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  return { status: res.status, contentType, text };
}

export function shortType(ct) {
  return (ct || '').split(';')[0].trim().slice(0, 60) || 'none';
}

export function looksLikeHtml(ct, text) {
  if (ct.includes('text/html')) return true;
  const head = text.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body');
}

export function looksLikeStream(ct, text) {
  if (ct.includes('text/event-stream')) return true;
  return /^\s*(data|event):/.test(text.slice(0, 50));
}

/** 将 HTTP 非 2xx 状态映射为错误码 */
export function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'http_auth';
  if (status === 404) return 'http_not_found';
  if (status === 413) return 'http_too_large';
  if (status === 429) return 'http_rate_limit';
  if (status === 400 || status === 422) return 'http_bad_request';
  if (status >= 500) return 'http_server';
  return 'http_other';
}

/** 从错误响应里尽量提取服务商给出的简短说明（只取 message 字段，最多 160 字，不回传原文） */
export function providerHint(text) {
  try {
    const j = JSON.parse(text);
    const d = j && j.detail;
    const m =
      (j && j.error && (typeof j.error === 'string' ? j.error : j.error.message || j.error.code)) ||
      j.message ||
      (d && typeof d === 'object' && !Array.isArray(d) ? d.message || d.code : Array.isArray(d) && d[0] ? d[0].msg : d);
    if (typeof m === 'string') return m.replace(/(sk|gsk|Bearer)[-_A-Za-z0-9]{8,}/g, '***').slice(0, 160);
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * 解析 2xx 的 JSON 响应体，区分空、网页、流式、无效 JSON
 */
export function parseJsonBody(r, stage) {
  const diag = { status: r.status, contentType: shortType(r.contentType), length: r.text.length };
  if (!r.text || !r.text.trim()) throw new AppError('empty_response', { stage, diag });
  if (looksLikeHtml(r.contentType, r.text)) throw new AppError('html_response', { stage, diag });
  if (looksLikeStream(r.contentType, r.text)) throw new AppError('unexpected_stream', { stage, diag });
  try {
    return JSON.parse(r.text);
  } catch {
    throw new AppError('invalid_json', { stage, diag });
  }
}

// 本地服务的错误单独说明，避免误导为云端 Key 问题
const LOCAL_CODES = { http_auth: 'local_http_auth', http_not_found: 'local_not_found', http_bad_request: 'local_bad_request', network: 'local_network' };

export function throwForStatus(r, stage) {
  if (r.status >= 200 && r.status < 300) return;
  const diag = { status: r.status, contentType: shortType(r.contentType), length: r.text.length };
  let code = looksLikeHtml(r.contentType, r.text) && r.status === 200 ? 'html_response' : httpErrorCode(r.status);
  if (stage === 'local') code = LOCAL_CODES[code] || code;
  throw new AppError(code, { stage, diag, detail: providerHint(r.text) });
}
