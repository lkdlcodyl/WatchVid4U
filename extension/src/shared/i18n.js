// 界面语言：中文原文即 key，英文译文在 i18n-en.js。发给模型的提示词不经过这里（决定笔记的输出语言）。
// 语言可在设置中切换：auto（跟随浏览器）/ zh / en。
import './i18n-en.js';

const EN = globalThis.WV4U_EN || {};
let lang = 'zh';

export const LANG_OPTIONS = [
  ['auto', '跟随浏览器'],
  ['zh', '简体中文'],
  ['en', 'English'],
];

export function resolveLang(pref, nav = (globalThis.navigator && navigator.language) || 'zh') {
  if (pref === 'zh' || pref === 'en') return pref;
  return /^zh/i.test(nav) ? 'zh' : 'en';
}

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'zh';
  if (globalThis.document && document.documentElement) document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
}

export function getLang() {
  return lang;
}

/** 翻译：s 为中文原文（可含 {name} 占位符）；没有译文时原样返回 */
export function t(s, params) {
  if (typeof s !== 'string') return s;
  let out = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : s;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return out;
}

/** 读取设置中的语言；pages 传 reload=true 时语言变化后刷新页面 */
export async function initLang({ reload = false } = {}) {
  const r = await chrome.storage.local.get('settings');
  setLang(resolveLang(r.settings && r.settings.ui && r.settings.ui.lang));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.settings) return;
    const next = resolveLang(ch.settings.newValue && ch.settings.newValue.ui && ch.settings.newValue.ui.lang);
    if (next === lang) return;
    setLang(next);
    if (reload && globalThis.location) location.reload();
  });
  return lang;
}

/** 翻译页面中静态写在 HTML 里的文字与 title / aria-label / placeholder */
export function translateDom(root = document) {
  if (lang === 'zh') return;
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const s = n.nodeValue.trim();
    if (s && Object.prototype.hasOwnProperty.call(EN, s)) n.nodeValue = n.nodeValue.replace(s, EN[s]);
  }
  for (const el of (root.body || root).querySelectorAll('[title],[aria-label],[placeholder]')) {
    for (const a of ['title', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && Object.prototype.hasOwnProperty.call(EN, v)) el.setAttribute(a, EN[v]);
    }
  }
  if (root.title && Object.prototype.hasOwnProperty.call(EN, root.title)) root.title = EN[root.title];
}
