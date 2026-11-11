// 16-bit PCM WAV 工具。录音以 16 kHz 单声道 Int16 分块保存，任意区间可精确拼成 WAV。

export const SAMPLE_RATE = 16000;
export const BYTES_PER_SAMPLE = 2;

export function wavHeader(sampleCount, sampleRate = SAMPLE_RATE, channels = 1) {
  const dataBytes = sampleCount * BYTES_PER_SAMPLE * channels;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true);
  v.setUint16(32, channels * BYTES_PER_SAMPLE, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  return buf;
}

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 每 frameSamples 个采样的 RMS（0..1） */
export function frameRms(f32, frameSamples = 1600) {
  const n = Math.ceil(f32.length / frameSamples);
  const out = new Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const a = f * frameSamples;
    const b = Math.min(f32.length, a + frameSamples);
    for (let i = a; i < b; i++) sum += f32[i] * f32[i];
    out[f] = Math.round(Math.sqrt(sum / Math.max(1, b - a)) * 1e5) / 1e5;
  }
  return out;
}

/**
 * 按采样区间 [start, end) 从分块列表中组装 WAV Blob。
 * chunks: [{startSample, sampleCount, blob}]，按 startSample 升序且连续。
 */
export function wavBlobForRange(chunks, start, end) {
  const parts = [];
  let total = 0;
  for (const c of chunks) {
    const cs = c.startSample;
    const ce = cs + c.sampleCount;
    if (ce <= start || cs >= end) continue;
    const a = Math.max(start, cs) - cs;
    const b = Math.min(end, ce) - cs;
    parts.push(a === 0 && b === c.sampleCount ? c.blob : c.blob.slice(a * BYTES_PER_SAMPLE, b * BYTES_PER_SAMPLE));
    total += b - a;
  }
  return new Blob([wavHeader(total), ...parts], { type: 'audio/wav' });
}

export function wavBlobAll(chunks) {
  const total = chunks.reduce((s, c) => s + c.sampleCount, 0);
  return new Blob([wavHeader(total), ...chunks.map((c) => c.blob)], { type: 'audio/wav' });
}

/** 生成测试用的短音频（固定材料，不含任何用户内容） */
export function testToneWav(seconds = 1.5, freq = 440) {
  const n = Math.round(SAMPLE_RATE * seconds);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 0.08 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * Math.min(1, i / 800, (n - i) / 800);
  const pcm = floatToInt16(f);
  return new Blob([wavHeader(n), pcm.buffer], { type: 'audio/wav' });
}
