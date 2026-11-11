// 转写与笔记任务（在 offscreen 文档中执行，不依赖任何用户页面保持打开）。
import { getMaterial, getChunks, updateMaterial, putRaw, getFrames } from '../shared/db.js';
import { selectFrames, fmtTs } from '../shared/frames.js';
import { initLang, t as tr } from '../shared/i18n.js';
initLang();
import { AppError } from '../shared/errors.js';
import { planSlices, trimTrailingSilence, planSignature } from '../shared/chunking.js';
import { wavBlobForRange, SAMPLE_RATE } from '../shared/wav.js';
import { transcribeBlob, filterSegments, buildSlicePrompt, joinTexts } from '../shared/stt.js';
import { mergeSlices, buildSpeakerTranscript, composeTranscript, textForLlm } from '../shared/transcript.js';
import { chatComplete } from '../shared/llm.js';
import { buildNoteMessages } from '../shared/prompts.js';

/**
 * cfg: {service:'stt'|'local', endpoint, key, model, language, prompt, responseFormat, sliceSec, maxUploadBytes, timeoutMs, filterLowConfidence, diarize}
 */
export async function runTranscribe({ materialId, cfg, signal, onProgress }) {
  const m = await getMaterial(materialId);
  if (!m) throw new AppError('db', { stage: 'stt', detail: '材料不存在' });
  if (!m.audio || m.audio.purged) throw new AppError('audio_missing', { stage: 'stt' });
  const chunks = await getChunks(materialId);
  if (!chunks.length) throw new AppError('audio_missing', { stage: 'stt' });
  const total = chunks.reduce((s, c) => s + c.sampleCount, 0);
  const rms = [];
  for (const c of chunks) rms.push(...(c.rms || []));
  const totalBytes = total * 2 + 44;

  let slices;
  if (cfg.service === 'local' && totalBytes <= cfg.maxUploadBytes) {
    // 本地后端：整段一次处理，说话人编号在整条音频内保持一致
    slices = [{ index: 0, start: 0, end: total, silent: false }];
  } else {
    slices = planSlices(rms, total, cfg.sliceSec, SAMPLE_RATE);
  }
  if (slices.every((s) => s.silent)) throw new AppError('empty_transcript', { stage: 'stt', detail: '录音全程接近静音，未发送' });
  const sig = `${planSignature(slices)}|${cfg.endpoint}|${cfg.model}`;
  // 从失败处继续：计划与服务一致时复用已完成分片
  let partial = m.sttPartial && m.sttPartial.sig === sig ? m.sttPartial : { sig, results: [] };
  const doneIdx = new Set(partial.results.map((r) => r.index));
  const nonSilent = slices.filter((s) => !s.silent).length;
  const report = () => onProgress({ done: partial.results.filter((r) => !r.silent).length, total: nonSilent, slices: slices.length });
  report();

  for (const slice of slices) {
    if (doneIdx.has(slice.index)) continue;
    if (signal.aborted) throw new AppError('cancelled', { stage: 'stt' });
    if (slice.silent) {
      partial.results.push({ index: slice.index, offsetSec: slice.start / SAMPLE_RATE, text: '', segments: [], silent: true });
      continue;
    }
    const isLast = slice.index === slices.length - 1;
    const s2 = isLast && cfg.service !== 'local' ? trimTrailingSilence(rms, slice, SAMPLE_RATE) : slice;
    const blob = wavBlobForRange(chunks, s2.start, s2.end);
    if (blob.size > cfg.maxUploadBytes) throw new AppError('local_too_large', { stage: 'stt', detail: tr('单片 {mb} MB', { mb: (blob.size / 1048576).toFixed(1) }) });
    const prev = partial.results.filter((r) => r.index < slice.index && r.text).sort((a, b) => b.index - a.index)[0];
    const prompt = buildSlicePrompt(cfg.prompt, prev ? prev.text : '');
    let res;
    try {
      res = await transcribeBlob({
        endpoint: cfg.endpoint,
        key: cfg.key,
        model: cfg.model,
        language: cfg.language,
        prompt,
        responseFormat: cfg.responseFormat,
        wavBlob: blob,
        timeoutMs: cfg.timeoutMs,
        signal,
        extraFields: cfg.service === 'local' ? { diarize: cfg.diarize ? 'true' : 'false' } : {},
        stage: cfg.service === 'local' ? 'local' : 'stt',
      });
    } catch (e) {
      // 保存已完成分片，标明失败位置
      await updateMaterial(materialId, (mm) => {
        mm.sttPartial = { ...partial, failedAt: slice.index, totalSlices: slices.length, updatedAt: Date.now() };
        return mm;
      });
      if (e instanceof AppError) e.detail = [e.detail, tr('第 {i}/{n} 片', { i: slice.index + 1, n: slices.length })].filter(Boolean).join('；');
      throw e;
    }
    const { segments, dropped } = filterSegments(res.segments, cfg.filterLowConfidence);
    const text = res.segments ? joinTexts(segments.map((s) => s.text)) : res.text.trim();
    partial.results.push({ index: slice.index, offsetSec: slice.start / SAMPLE_RATE, text, segments: res.segments ? segments : null, dropped, speakers: res.speakers || null });
    await putRaw(materialId, `stt-${slice.index}`, { text: res.text, segmentsCount: res.segments ? res.segments.length : null, format: cfg.responseFormat, model: cfg.model });
    await updateMaterial(
      materialId,
      (mm) => {
        mm.sttPartial = { ...partial, failedAt: null, totalSlices: slices.length, updatedAt: Date.now() };
        return mm;
      },
      { silent: true },
    );
    report();
  }

  const results = partial.results.sort((a, b) => a.index - b.index);
  const merged = mergeSlices(results);
  if (!merged.plain.trim()) {
    throw new AppError('empty_transcript', { stage: 'stt' });
  }
  const speakersInfo = results.length === 1 ? results[0].speakers : null; // 跨片无法保证编号一致时不做说话人分段
  const speakerText = buildSpeakerTranscript(merged.segments, speakersInfo);
  const dropped = results.reduce((s, r) => s + (r.dropped || 0), 0);
  const transcript = composeTranscript({
    plain: merged.plain,
    speaker: speakerText,
    source: 'stt',
    model: cfg.model,
    segments: merged.segments,
    droppedSegments: dropped,
    sliceCount: nonSilent,
    sttMeta: { service: cfg.service, speakers: speakersInfo ? { count: speakersInfo.count, reliable: !!speakersInfo.reliable, error: speakersInfo.error || null } : null, partialAudio: !m.audio.complete },
  });
  await putRaw(materialId, 'stt-merged-raw', { text: joinTexts(results.map((r) => r.text)) });
  const saved = await updateMaterial(materialId, (mm) => {
    mm.transcriptVersion = (mm.transcriptVersion || 0) + 1;
    transcript.version = mm.transcriptVersion;
    mm.transcript = transcript;
    mm.sttPartial = null;
    mm.lastError = null;
    return mm;
  });
  return { chars: transcript.effective.length, kind: transcript.kind, version: saved.transcriptVersion };
}

/** cfg: {endpoint, key, model, maxInputChars, maxTokens, temperature, timeoutMs, ignorePromo, maxFrames} */
export async function runNote({ materialId, mode, cfg, signal }) {
  const m = await getMaterial(materialId);
  if (!m) throw new AppError('db', { stage: 'llm', detail: '材料不存在' });
  if (!m.transcript || !m.transcript.effective) throw new AppError('transcript_missing', { stage: 'llm' });
  // 附带画面：仅当用户开启并授权、且该材料录制时保存了画面
  let frames = [];
  if (cfg.maxFrames > 0 && m.frames && m.frames.count) {
    const all = await getFrames(materialId);
    const picked = selectFrames(all, cfg.maxFrames, m.audio?.adIntervals || []);
    frames = await Promise.all(picked.map(async (f) => ({ t: f.t, label: fmtTs(f.t), dataUrl: await blobToDataUrl(f.blob) })));
  }
  const { text, adEvidence, timed } = textForLlm(m, { timestamps: frames.length > 0 });
  if (text.length > cfg.maxInputChars) {
    throw new AppError('local_too_large', { stage: 'llm', detail: tr('逐字稿 {n} 字，超过设置的 {max} 字上限；未截断发送', { n: text.length, max: cfg.maxInputChars }) });
  }
  const messages = buildNoteMessages({
    transcript: text,
    mode,
    platform: m.platform,
    ignorePromo: cfg.ignorePromo,
    adEvidence,
    isAudioDerived: m.transcript.source === 'stt',
    frames,
    timed,
  });
  let res;
  try {
    res = await chatComplete({
      endpoint: cfg.endpoint,
      key: cfg.key,
      model: cfg.model,
      messages,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      timeoutMs: cfg.timeoutMs,
      signal,
    });
  } catch (e) {
    // 带图片的请求被拒绝时，大多是模型不支持图片输入
    if (frames.length && e && (e.code === 'http_bad_request' || e.code === 'http_not_found')) {
      e.detail = `${e.detail ? e.detail + tr('；') : ''}${tr('本次发送了 {n} 张截图，当前模型可能不支持图片输入：请换用支持图片的模型，或在设置 →“视频画面”中关闭“生成笔记时，把截图发给笔记模型参考”', { n: frames.length })}`;
    }
    throw e;
  }
  await updateMaterial(materialId, (mm) => {
    mm.notes = mm.notes || {};
    mm.notes[mode] = {
      markdown: res.content,
      mode,
      createdAt: Date.now(),
      transcriptVersion: mm.transcriptVersion || 1,
      transcriptKind: mm.transcript.kind,
      model: res.model || cfg.model,
      adEvidence,
      frames: frames.length,
    };
    mm.lastNoteMode = mode;
    mm.lastError = null;
    return mm;
  });
  return { chars: res.content.length };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
