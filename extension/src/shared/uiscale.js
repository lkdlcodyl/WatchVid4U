/*
 * 界面尺寸自适应（经典脚本：扩展页面在 <head> 同步加载以避免首帧跳变；内容脚本在 content.js 之前加载）。
 *
 * 不是“整体乘一个系数”，而是三层：
 *  1. 平台配置（profile）：各系统的逻辑像素密度与原生 UI 习惯不同——macOS 的逻辑像素更密（约 110–130/英寸），
 *     原生正文 13pt；Windows 按 96 dpi 设计、原生正文 9pt（12px），控件更紧凑，中文字体没有“半粗”字重。
 *     每个平台有自己的基准比例、字号阶梯（小字缩得少、大标题缩得多）和字重映射，由 CSS 中 html[data-os] 下的令牌实现。
 *  2. 字形校正（fontFactor）：在运行时测量当前系统实际使用的中文字体的字面大小（雅黑的字面明显比苹方大），
 *     按参考字体（苹方，实测字面约 0.83em）归一，使不同字体下“看起来”同样大。
 *  3. 用户微调（80%–125%）：设置里的“界面比例”。
 * 都以 rem 百分比实现，浏览器自身的字号与缩放设置仍然生效。
 */
(function (g) {
  'use strict';
  // 各平台基准比例（相对 macOS 设计稿）
  const PROFILE_BASE = { mac: 1, windows: 0.875, linux: 0.9, chromeos: 0.95, other: 1 };
  // 参考字体（苹方 SC）“国回图田”平均字面尺寸 / 字号，实测 0.8285
  const REF_FACE = 0.8285;
  const FACE_MIN = 0.86;
  const FACE_MAX = 1.04;
  const USER_MIN = 80;
  const USER_MAX = 125;
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", Roboto, sans-serif';
  const CACHE_KEY = 'wv4u.uiScale';

  function detectOS(nav) {
    nav = nav || (typeof navigator !== 'undefined' ? navigator : {});
    const p = ((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '').toLowerCase();
    if (p.includes('win')) return 'windows';
    if (p.includes('mac')) return 'mac';
    if (p.includes('cros') || p.includes('chrome os')) return 'chromeos';
    if (p.includes('linux') || p.includes('x11')) return 'linux';
    return 'other';
  }

  /** 由字面比例得到字形校正系数（纯函数，便于测试） */
  function faceFactor(face) {
    if (!(face > 0.3 && face < 1.3)) return 1;
    return Math.min(FACE_MAX, Math.max(FACE_MIN, REF_FACE / face));
  }

  let measured = null;
  /** 测量当前字体栈中文字面占字号的比例（无 canvas 时返回 null） */
  function measureFace(stack) {
    if (measured && !stack) return measured;
    try {
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
      const c = cv.getContext('2d');
      c.font = '100px ' + (stack || FONT_STACK);
      let sum = 0;
      for (const ch of '国回图田') {
        const m = c.measureText(ch);
        sum += m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      }
      const face = sum / 8 / 100;
      if (!(face > 0)) return null;
      if (!stack) measured = face;
      return face;
    } catch {
      return null;
    }
  }

  /** 旧版“界面大小”取值迁移为百分比 */
  function userPercent(ui) {
    ui = ui || {};
    let v = Number(ui.scale);
    if (!Number.isFinite(v) || v <= 0) v = ui.density === 'compact' ? 90 : ui.density === 'large' ? 112.5 : 100;
    return Math.min(USER_MAX, Math.max(USER_MIN, v));
  }

  /** 计算最终比例：平台基准 × 字形校正 × 用户微调 */
  function compute(opts) {
    opts = opts || {};
    const os = opts.os || detectOS();
    const face = opts.face !== undefined ? opts.face : measureFace();
    const base = PROFILE_BASE[os] || 1;
    const ff = face ? faceFactor(face) : 1;
    const user = userPercent(opts.ui);
    const scale = Math.round(base * ff * (user / 100) * 1000) / 1000;
    return { os, base, face, fontFactor: Math.round(ff * 1000) / 1000, user, scale };
  }

  /** 应用到扩展页面根元素；ui 未知时使用上次缓存的用户比例，保证首帧即为正确尺寸 */
  function applyRoot(ui) {
    const root = document.documentElement;
    if (ui === undefined) {
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (c) ui = c;
      } catch {}
    } else {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ scale: userPercent(ui) }));
      } catch {}
    }
    const r = compute({ ui });
    root.dataset.os = r.os;
    root.style.setProperty('--ui-scale', String(r.scale));
    return r;
  }

  g.WV4UScale = { detectOS, faceFactor, measureFace, userPercent, compute, applyRoot, PROFILE_BASE, REF_FACE, USER_MIN, USER_MAX };
  if (typeof document !== 'undefined' && document.documentElement && typeof chrome !== 'undefined' && chrome.runtime && location.protocol === 'chrome-extension:') {
    applyRoot();
  }
})(globalThis);
