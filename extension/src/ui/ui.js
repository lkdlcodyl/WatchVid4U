// 界面公共工具：消息、主题、DOM 构建（只用 textContent，不拼接 HTML）、提示、确认框。
// h() 会自动翻译 text / title / aria-label / placeholder 与字符串子节点中能精确匹配的界面文案。
import { t, getLang } from '../shared/i18n.js';
import { messageFor } from '../shared/errors.js';
export { t };

export async function sw(type, payload = {}) {
  try {
    const r = await chrome.runtime.sendMessage({ target: 'sw', type, ...payload });
    return r || { ok: false, error: { message: '后台无响应' } };
  } catch (e) {
    return { ok: false, error: { message: '无法连接扩展后台，请重新打开' } };
  }
}

// 尺寸自适应由 <head> 中同步加载的 shared/uiscale.js 在首帧前完成；这里在读到设置后按用户微调更新

export async function applyTheme() {
  const r = await chrome.storage.local.get('settings');
  const ui = (r.settings && r.settings.ui) || {};
  const theme = ui.theme || 'system';
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (globalThis.WV4UScale) globalThis.WV4UScale.applyRoot(ui);
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.settings) applyTheme();
});

/** h('div', {class:'x', onclick: fn}, 'text', child) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = t(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'hidden') el.hidden = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'value') el.value = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'title' || k === 'aria-label' || k === 'placeholder') el.setAttribute(k, t(v));
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(t(String(c))));
  }
  return el;
}

const ICONS = {
  play: 'M8 5.5v13l10.5-6.5z',
  restart: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4',
  stop: 'M7 7h10v10H7z',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  gear: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7 7 0 0 1-1.6.9L15.4 20h-3.6l-.3-2a7 7 0 0 1-1.6-.9l-1.9.7-1.8-3.1 1.6-1.2a7 7 0 0 1 0-1.9L6.2 10.4 8 7.3l1.9.7a7 7 0 0 1 1.6-.9l.3-2h3.6l.3 2a7 7 0 0 1 1.6.9l1.9-.7 1.8 3.1-1.6 1.2a7 7 0 0 1 0 1.9z',
  copy: 'M8.5 8.5h10v11h-10zM5.5 15.5v-11h10',
  download: 'M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  float: 'M4.5 5.5h15v13h-15zM13 12.5h4.5v4H13z',
  back: 'M14.5 6l-6 6 6 6',
  trash: 'M5 7h14M9.5 7V5h5v2M7 7l1 12.5h8L17 7',
  headphones: 'M5 14v-2a7 7 0 0 1 14 0v2M5 14h2.5v5H5zM16.5 14H19v5h-2.5z',
  note: 'M6 4.5h9l3 3v12H6zM9 11h6M9 14.5h6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 16H3zM12 10v4.5M12 17.2v.3',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5M12 3.5C9.7 5.9 8.5 8.7 8.5 12s1.2 6.1 3.5 8.5',
};

export function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.7');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  if (name === 'play' || name === 'stop') p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

let toastHost = null;
export function toast(text, ms = 3200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: 'toast', text });
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** 确认框。body 可为字符串或节点；返回 Promise<boolean> */
export function confirmDialog({ title, body, ok = '确定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h(
      'dialog',
      { 'aria-labelledby': 'dlg-title' },
      h('div', { class: 'dlg-body' }, h('h2', { id: 'dlg-title', text: title }), typeof body === 'string' ? h('p', { text: body }) : body),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel', text: cancel }), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, value: 'ok', text: ok })),
    );
    dlg.querySelectorAll('.dlg-actions button').forEach((b) =>
      b.addEventListener('click', () => {
        dlg.close(b.value);
      }),
    );
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('.dlg-actions .btn:last-child').focus();
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? '已复制' : '复制失败，请手动选择文本');
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 错误说明：按错误码取当前语言的说明（切换语言后旧错误也会显示为新语言） */
export function errText(e) {
  if (!e) return '';
  const msg = e.code ? t(messageFor(e.code)) : t(e.message || '操作失败');
  const detail = e.detail ? t(e.detail) : '';
  return msg + (detail ? (getLang() === 'en' ? ` (${detail})` : `（${detail}）`) : '');
}
