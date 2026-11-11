// 安全的 Markdown 子集渲染：先解析为结构，再用 textContent 构建 DOM。从不使用 innerHTML，不执行任何脚本或 HTML。

export function parseMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isBlank = (l) => !l.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(/^```\s*([\w-]*)\s*$/))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: buf.join('\n') });
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      blocks.push({ type: 'heading', level: m[1].length, inline: parseInline(m[2]) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', children: parseMarkdown(buf.join('\n')) });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows = [];
      const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));
      const head = split(line);
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(split(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      const ordered = /\d/.test(m[2]);
      const baseIndent = m[1].length;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const mm = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (mm && mm[1].length <= baseIndent + 1 && /\d/.test(mm[2]) === ordered) {
          items.push({ inline: parseInline(mm[3]), sub: [] });
          i++;
        } else if (mm && mm[1].length > baseIndent + 1 && items.length) {
          const subLines = [];
          while (i < lines.length && (lines[i].match(/^(\s*)/)[1].length > baseIndent + 1) && !isBlank(lines[i])) subLines.push(lines[i++].slice(baseIndent + 2));
          items[items.length - 1].sub.push(...parseMarkdown(subLines.join('\n')));
        } else if (!isBlank(l) && !mm && /^\s+\S/.test(l) && items.length) {
          items[items.length - 1].inline.push({ t: 'text', v: ' ' }, ...parseInline(l.trim()));
          i++;
        } else break;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    const inline = [];
    buf.forEach((l, k) => {
      if (k) inline.push({ t: 'br' });
      inline.push(...parseInline(l));
    });
    blocks.push({ type: 'p', inline });
  }
  return blocks;
}

export function parseInline(s) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const tok = m[0];
    if (m[1]) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (m[2]) out.push({ t: 'strong', c: parseInline(tok.slice(2, -2)) });
    else if (m[3]) out.push({ t: 'em', c: parseInline(tok.slice(1, -1)) });
    else if (m[4]) {
      const mm = tok.match(/^\[([^\]]+)\]\((.+)\)$/);
      out.push({ t: 'link', c: parseInline(mm[1]), href: mm[2] });
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

function safeHref(h) {
  try {
    const u = new URL(h);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function renderInline(doc, parent, nodes) {
  for (const n of nodes) {
    if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
    else if (n.t === 'br') parent.appendChild(doc.createElement('br'));
    else if (n.t === 'code') {
      const e = doc.createElement('code');
      e.textContent = n.v;
      parent.appendChild(e);
    } else if (n.t === 'strong' || n.t === 'em') {
      const e = doc.createElement(n.t);
      renderInline(doc, e, n.c);
      parent.appendChild(e);
    } else if (n.t === 'link') {
      const href = safeHref(n.href);
      if (href) {
        const a = doc.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        renderInline(doc, a, n.c);
        parent.appendChild(a);
      } else renderInline(doc, parent, n.c);
    }
  }
}

export function renderBlocks(doc, parent, blocks) {
  for (const b of blocks) {
    let e;
    switch (b.type) {
      case 'heading':
        e = doc.createElement('h' + Math.min(6, b.level + 1)); // 页面已有 h1，笔记标题降一级
        renderInline(doc, e, b.inline);
        break;
      case 'p':
        e = doc.createElement('p');
        renderInline(doc, e, b.inline);
        break;
      case 'hr':
        e = doc.createElement('hr');
        break;
      case 'code':
        e = doc.createElement('pre');
        e.textContent = b.text;
        break;
      case 'quote':
        e = doc.createElement('blockquote');
        renderBlocks(doc, e, b.children);
        break;
      case 'ul':
      case 'ol':
        e = doc.createElement(b.type);
        for (const it of b.items) {
          const li = doc.createElement('li');
          renderInline(doc, li, it.inline);
          if (it.sub.length) renderBlocks(doc, li, it.sub);
          e.appendChild(li);
        }
        break;
      case 'table': {
        e = doc.createElement('div');
        e.className = 'table-wrap';
        const t = doc.createElement('table');
        const thead = doc.createElement('thead');
        const hr = doc.createElement('tr');
        for (const c of b.head) {
          const th = doc.createElement('th');
          renderInline(doc, th, c);
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        t.appendChild(thead);
        const tb = doc.createElement('tbody');
        for (const r of b.rows) {
          const tr = doc.createElement('tr');
          for (const c of r) {
            const td = doc.createElement('td');
            renderInline(doc, td, c);
            tr.appendChild(td);
          }
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        e.appendChild(t);
        break;
      }
      default:
        continue;
    }
    parent.appendChild(e);
  }
}

/** 渲染到容器；任何异常都回退为纯文本，保证内容可读 */
export function renderMarkdownInto(container, src) {
  container.replaceChildren();
  try {
    renderBlocks(container.ownerDocument, container, parseMarkdown(src));
    return true;
  } catch {
    const pre = container.ownerDocument.createElement('pre');
    pre.className = 'fallback';
    pre.textContent = String(src || '');
    container.replaceChildren(pre);
    return false;
  }
}
