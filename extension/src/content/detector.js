// 页面判定的纯逻辑（内容脚本与测试共用）。不访问 chrome.* 与网络。
(function (root) {
  if (root.WV4U_DETECT) return;

  function platformOf(href) {
    let h = '';
    try {
      h = new URL(href).hostname;
    } catch (e) {
      return 'generic';
    }
    if (/(^|\.)bilibili\.com$/.test(h)) return 'bilibili';
    if (/(^|\.)youtube\.com$/.test(h)) return 'youtube';
    if (/(^|\.)douyin\.com$/.test(h)) return 'douyin';
    return 'generic';
  }

  // 与 src/shared/platform.js 的 videoKeyFromUrl 保持一致
  function videoKeyOf(href) {
    let u;
    try {
      u = new URL(href);
    } catch (e) {
      return null;
    }
    const p = platformOf(href);
    if (p === 'bilibili') {
      const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?/i);
      if (m) {
        const pp = Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1);
        const id = /^av/i.test(m[1]) ? 'av' + m[1].slice(2) : m[1];
        return 'bili:' + id + ':p' + pp;
      }
      if (/^\/list\//.test(u.pathname)) {
        const b = u.searchParams.get('bvid');
        if (b && /^BV[0-9A-Za-z]{10}$/.test(b)) return 'bili:' + b + ':p' + Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1);
      }
      return null;
    }
    if (p === 'youtube') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return 'yt:' + u.searchParams.get('v');
      const s = u.pathname.match(/^\/shorts\/([\w-]+)/);
      return s ? 'yts:' + s[1] : null;
    }
    if (p === 'douyin') {
      const m = u.pathname.match(/\/video\/(\d+)/);
      if (m) return 'dy:' + m[1];
      const mid = u.searchParams.get('modal_id');
      return mid ? 'dy:' + mid : null;
    }
    return 'web:' + u.origin + u.pathname;
  }

  /** YouTube 广告状态：'ad' | 'content' | 'unknown' */
  function youtubeAdState(doc) {
    const player = doc.querySelector('#movie_player') || doc.querySelector('.html5-video-player');
    if (!player) return 'unknown';
    const cl = player.classList;
    if (cl.contains('ad-showing') || cl.contains('ad-interrupting')) return 'ad';
    if (doc.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text, .ytp-ad-preview-container')) {
      const el = doc.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-preview-container');
      if (el && el.getClientRects().length) return 'ad';
    }
    return 'content';
  }

  function visibleArea(el, win) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  const PLATFORM_SELECTORS = {
    bilibili: ['.bpx-player-video-wrap video', '#bilibili-player video', '.bilibili-player-video video', 'bwp-video'],
    youtube: ['#movie_player video.html5-main-video', '#movie_player video'],
    douyin: [],
    generic: [],
  };

  /** 选出目标媒体元素 */
  function pickTarget(doc, win, platform) {
    for (const sel of PLATFORM_SELECTORS[platform] || []) {
      const el = doc.querySelector(sel);
      if (el && typeof el.play === 'function') return el;
    }
    const media = Array.from(doc.querySelectorAll(platform === 'generic' ? 'video, audio' : 'video'));
    let best = null;
    let bestScore = -1;
    for (const el of media) {
      const area = el.tagName === 'AUDIO' ? 1 : visibleArea(el, win);
      if (el.tagName === 'VIDEO' && area < 40 * 40) continue;
      const playing = !el.paused && !el.ended && el.readyState > 2;
      const hasDur = Number.isFinite(el.duration) && el.duration > 0;
      const score = area * (playing ? 4 : 1) * (hasDur ? 2 : 1);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * 判定一次 ended（或等效的“停在结尾”）是否为正文结束。
   * 返回 'content-end' | 'ad-end' | 'unknown'
   */
  function judgeEnd(ctx) {
    const { platform, adState, duration, currentTime, contentDuration } = ctx;
    if (platform === 'youtube') {
      if (adState === 'ad') return 'ad-end';
      if (adState === 'unknown') return 'unknown';
      if (contentDuration && Number.isFinite(duration) && Math.abs(duration - contentDuration) > 3) return 'unknown';
    }
    if (!Number.isFinite(duration) || duration <= 0) return 'unknown';
    if (currentTime >= duration - 1.5) return 'content-end';
    return 'unknown';
  }

  /** 循环检测：上次时间接近结尾、本次回到开头且近期无用户操作 → 判为自动从头循环 */
  function isLoopWrap(prevTime, curTime, duration, sinceUserMs) {
    if (!Number.isFinite(duration) || duration <= 2) return false;
    return prevTime >= duration - 1.2 && curTime < 1.0 && sinceUserMs > 1500;
  }

  /** “停在结尾”的暂停（部分播放器不触发 ended） */
  function isPauseAtEnd(currentTime, duration) {
    return Number.isFinite(duration) && duration > 0 && currentTime >= duration - 0.35;
  }

  function cleanTitle(title, platform) {
    let t = String(title || '').trim();
    if (platform === 'bilibili') t = t.replace(/_哔哩哔哩_bilibili$/, '').replace(/_bilibili$/i, '');
    if (platform === 'youtube') t = t.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
    if (platform === 'douyin') t = t.replace(/\s*-\s*抖音$/, '');
    return t.slice(0, 200);
  }

  function isEditableTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
    }
    return !!(el.closest && el.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
  }

  root.WV4U_DETECT = { platformOf, videoKeyOf, youtubeAdState, pickTarget, judgeEnd, isLoopWrap, isPauseAtEnd, cleanTitle, isEditableTarget };
})(typeof globalThis !== 'undefined' ? globalThis : window);
