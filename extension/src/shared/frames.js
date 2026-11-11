// 截帧的纯函数部分（可在任何环境测试）：黑屏判断、相似度去重、发给模型时的挑选。

/** 缩略灰度图的亮度统计：{mean, std}（0–255） */
export function grayStats(gray) {
  let sum = 0;
  for (const v of gray) sum += v;
  const mean = gray.length ? sum / gray.length : 0;
  let acc = 0;
  for (const v of gray) acc += (v - mean) * (v - mean);
  return { mean, std: gray.length ? Math.sqrt(acc / gray.length) : 0 };
}

/** 近乎全黑且无内容（受 DRM 保护的视频、加载中的黑屏），不保存 */
export function isBlankFrame(gray) {
  const { mean, std } = grayStats(gray);
  return mean < 12 && std < 4;
}

/** 两张缩略灰度图的平均逐像素差（0–255）；尺寸不同视为完全不同 */
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

/** 与上一张保存的画面几乎相同（静态画面、暂停画面），不重复保存 */
export const DUP_THRESHOLD = 4;
export function isDuplicateFrame(prev, cur) {
  return frameDiff(prev, cur) < DUP_THRESHOLD;
}

/**
 * 从已保存的截帧中挑选最多 max 张发给模型：排除广告时段，其余按时间均匀抽取（保留首尾）。
 * frames: [{seq, t}]；adIntervals: [[start, end]]（秒）
 */
export function selectFrames(frames, max, adIntervals = []) {
  const inAd = (t) => adIntervals.some(([a, b]) => t >= a && t <= b);
  const pool = (frames || []).filter((f) => !inAd(f.t)).sort((a, b) => a.t - b.t);
  if (max <= 0 || !pool.length) return [];
  if (pool.length <= max) return pool;
  if (max === 1) return [pool[Math.floor(pool.length / 2)]];
  const out = [];
  for (let i = 0; i < max; i++) out.push(pool[Math.round((i * (pool.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/** 秒 → m:ss 或 h:mm:ss */
export function fmtTs(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
