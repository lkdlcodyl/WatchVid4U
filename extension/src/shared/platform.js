// 平台识别与“视频身份”键（内容脚本中有同逻辑的副本，修改时请同步 src/content/detector.js）。
import { biliVideoKey } from './bilibili.js';

export function detectPlatform(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return 'generic';
  }
  const h = u.hostname;
  if (/(^|\.)bilibili\.com$/.test(h)) return 'bilibili';
  if (/(^|\.)youtube\.com$/.test(h)) return 'youtube';
  if (/(^|\.)douyin\.com$/.test(h)) return 'douyin';
  return 'generic';
}

/** 依据 URL 得到视频身份；无法从 URL 判断时返回 null（交由内容脚本按媒体元素判断） */
export function videoKeyFromUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const p = detectPlatform(href);
  if (p === 'bilibili') return biliVideoKey(href);
  if (p === 'youtube') {
    if (u.pathname === '/watch' && u.searchParams.get('v')) return `yt:${u.searchParams.get('v')}`;
    const s = u.pathname.match(/^\/shorts\/([\w-]+)/);
    return s ? `yts:${s[1]}` : null;
  }
  if (p === 'douyin') {
    const m = u.pathname.match(/\/video\/(\d+)/);
    if (m) return `dy:${m[1]}`;
    const mid = u.searchParams.get('modal_id');
    return mid ? `dy:${mid}` : null;
  }
  return `web:${u.origin}${u.pathname}`;
}

export function isCapturableUrl(href) {
  return /^https?:\/\//.test(href || '') && !/^https:\/\/chrome(webstore)?\.google\.com\/webstore/.test(href) && !/^https:\/\/chromewebstore\.google\.com/.test(href);
}
