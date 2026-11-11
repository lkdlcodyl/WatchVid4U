// 长音频分片：在目标边界附近寻找最安静的位置切分，避免切断语句；完全静音的片段不发送（减少幻觉与费用）。

export const FRAME_SEC = 0.1; // rms 帧长（与录音端 frameRms 的 1600 采样 @16k 对应）
export const SILENCE_RMS = 0.004; // 约 -48 dBFS
const SEARCH_BACK_SEC = 30;
const QUIET_WIN_FRAMES = 4; // 0.4 s

/**
 * @param {number[]} rms 每 0.1 s 一个 RMS 值（覆盖整段音频）
 * @param {number} totalSamples 总采样数
 * @param {number} sliceSec 单片最长秒数
 * @param {number} sampleRate
 * @returns {{index:number,start:number,end:number,silent:boolean}[]} 采样区间
 */
export function planSlices(rms, totalSamples, sliceSec, sampleRate = 16000) {
  const totalSec = totalSamples / sampleRate;
  const slices = [];
  if (totalSamples <= 0) return slices;
  const frameSamples = Math.round(FRAME_SEC * sampleRate);
  let startFrame = 0;
  const totalFrames = Math.ceil(totalSamples / frameSamples);
  const maxFrames = Math.floor(sliceSec / FRAME_SEC);
  while (startFrame < totalFrames) {
    let endFrame;
    if (totalFrames - startFrame <= maxFrames) {
      endFrame = totalFrames;
    } else {
      const target = startFrame + maxFrames;
      const lo = Math.max(startFrame + Math.floor(maxFrames / 2), target - Math.round(SEARCH_BACK_SEC / FRAME_SEC));
      endFrame = quietestCut(rms, lo, target);
    }
    const start = startFrame * frameSamples;
    const end = Math.min(totalSamples, endFrame * frameSamples);
    slices.push({ index: slices.length, start, end, silent: isSilent(rms, startFrame, endFrame) });
    startFrame = endFrame;
  }
  // 防御：保证覆盖完整且无重叠
  if (slices.length && slices[slices.length - 1].end !== totalSamples) slices[slices.length - 1].end = totalSamples;
  void totalSec;
  return slices;
}

function avg(rms, a, b) {
  let s = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    s += rms[i] ?? 0;
    n++;
  }
  return n ? s / n : 0;
}

/** 在 [lo, hi] 帧区间寻找 0.4 s 窗口均值最低处，返回窗口中点帧；并列时取更靠后的（更接近目标长度） */
export function quietestCut(rms, lo, hi) {
  let best = hi;
  let bestVal = Infinity;
  for (let f = lo; f <= hi - QUIET_WIN_FRAMES; f++) {
    const v = avg(rms, f, f + QUIET_WIN_FRAMES);
    if (v <= bestVal) {
      bestVal = v;
      best = f + Math.floor(QUIET_WIN_FRAMES / 2);
    }
  }
  return Math.max(lo + 1, Math.min(hi, best));
}

export function isSilent(rms, a, b) {
  for (let i = a; i < b; i++) if ((rms[i] ?? 0) > SILENCE_RMS) return false;
  return true;
}

/** 片尾静音裁剪（仅最后一片）：保留 1 s 静音余量，避免把长静音交给模型续写 */
export function trimTrailingSilence(rms, slice, sampleRate = 16000) {
  const frameSamples = Math.round(FRAME_SEC * sampleRate);
  const a = Math.floor(slice.start / frameSamples);
  let b = Math.ceil(slice.end / frameSamples);
  while (b > a + 1 && (rms[b - 1] ?? 0) <= SILENCE_RMS) b--;
  const end = Math.min(slice.end, (b + 10) * frameSamples);
  return { ...slice, end: Math.max(slice.start + frameSamples, end) };
}

export function planSignature(slices) {
  return slices.map((s) => `${s.start}-${s.end}`).join(',');
}
