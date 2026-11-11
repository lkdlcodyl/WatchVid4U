// OpenAI 兼容的同步音频转写客户端（/audio/transcriptions，multipart）。
import { AppError } from './errors.js';
import { requestText, throwForStatus, parseJsonBody, shortType } from './http.js';

/**
 * @returns {Promise<{text:string, segments:Array<{start:number,end:number,text:string,no_speech_prob?:number,avg_logprob?:number,compression_ratio?:number,speaker?:string|null}>|null, speakers?:object|null, raw:string}>}
 */
export async function transcribeBlob({ endpoint, key, model, language, prompt, responseFormat, wavBlob, timeoutMs, signal, extraFields = {}, stage = 'stt' }) {
  const form = new FormData();
  form.append('file', wavBlob, 'audio.wav');
  form.append('model', (model || '').trim() || 'auto');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  form.append('response_format', responseFormat || 'json');
  form.append('temperature', '0');
  for (const [k, v] of Object.entries(extraFields)) form.append(k, String(v));
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await requestText(endpoint, { method: 'POST', headers, body: form }, { timeoutMs, signal, stage });
  throwForStatus(r, stage);
  if (responseFormat === 'text') {
    const diag = { status: r.status, contentType: shortType(r.contentType), length: r.text.length };
    if (/text\/html/.test(r.contentType)) throw new AppError('html_response', { stage, diag });
    return { text: r.text.trim(), segments: null, raw: r.text };
  }
  const j = parseJsonBody(r, stage);
  if (!j || typeof j.text !== 'string') throw new AppError('unexpected_shape', { stage, diag: { status: r.status, contentType: shortType(r.contentType), length: r.text.length } });
  const segments = Array.isArray(j.segments)
    ? j.segments
        .filter((s) => s && typeof s.text === 'string')
        .map((s) => ({
          start: +s.start || 0,
          end: +s.end || 0,
          text: s.text,
          no_speech_prob: s.no_speech_prob,
          avg_logprob: s.avg_logprob,
          compression_ratio: s.compression_ratio,
          speaker: s.speaker ?? null,
        }))
    : null;
  return { text: j.text, segments, speakers: j.speakers || null, raw: r.text };
}

/**
 * 依据模型自带的置信度信号过滤疑似无语音或重复幻觉段落（Whisper 推荐的判据），
 * 不按语言、关键词或重复词硬删。返回 {segments, dropped}
 */
export function filterSegments(segments, enabled = true) {
  if (!segments || !enabled) return { segments: segments || [], dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const s of segments) {
    const noSpeech = typeof s.no_speech_prob === 'number' && typeof s.avg_logprob === 'number' && s.no_speech_prob > 0.6 && s.avg_logprob < -1.0;
    const loop = typeof s.compression_ratio === 'number' && s.compression_ratio > 2.4 && typeof s.avg_logprob === 'number' && s.avg_logprob < -1.0;
    if (noSpeech || loop) dropped++;
    else kept.push(s);
  }
  return { segments: kept, dropped };
}

/** 中文分段拼接：中文之间不加空格，中英之间保留一个空格 */
export function joinTexts(parts) {
  let out = '';
  for (let p of parts) {
    p = (p || '').trim();
    if (!p) continue;
    if (!out) {
      out = p;
      continue;
    }
    const a = out[out.length - 1];
    const b = p[0];
    const asciiA = /[A-Za-z0-9]/.test(a);
    const asciiB = /[A-Za-z0-9]/.test(b);
    out += asciiA && asciiB ? ' ' + p : asciiA !== asciiB && /[A-Za-z0-9]/.test(a + b) ? ' ' + p : p;
  }
  return out;
}

/** 下一片的 prompt：标点引导 + 上一片末尾上下文（Whisper prompt 有长度上限，取尾部约 120 字） */
export function buildSlicePrompt(guide, prevText) {
  const tail = (prevText || '').trim().slice(-120);
  const g = (guide || '').trim();
  if (!tail) return g;
  return g ? `${g}\n${tail}` : tail;
}
