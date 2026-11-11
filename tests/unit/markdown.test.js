import { test, describe, assert } from './harness.js';
import { parseMarkdown, renderMarkdownInto } from '../../extension/src/shared/markdown.js';

describe('markdown', () => {
  test('解析常用结构', () => {
    const b = parseMarkdown('# 标题\n\n段落 **粗** *斜*\n\n- a\n- b\n  - c\n\n1. x\n2. y\n\n> 引用\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n```\ncode\n```');
    assert.deepEqual(b.map((x) => x.type), ['heading', 'p', 'ul', 'ol', 'quote', 'table', 'hr', 'code']);
    assert.equal(b[2].items[1].sub[0].type, 'ul');
  });
  test('脚本与 HTML 只作为文本显示，危险链接被丢弃', () => {
    const div = document.createElement('div');
    renderMarkdownInto(div, '<script>window.__pwned=1</script>\n\n<img src=x onerror="window.__pwned=2">\n\n[x](javascript:alert(1)) [ok](https://example.com)');
    document.body.appendChild(div);
    assert.equal(div.querySelectorAll('script,img').length, 0);
    assert.match(div.textContent, /<script>/);
    const links = div.querySelectorAll('a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://example.com/');
    assert.equal(links[0].rel, 'noopener noreferrer');
    assert.equal(window.__pwned, undefined);
    assert.notMatch(div.textContent, /alert\(1\)\)/, '括号内的危险链接被完整识别并丢弃');
    div.remove();
  });
  test('标题降一级（页面已有 h1）', () => {
    const div = document.createElement('div');
    renderMarkdownInto(div, '# A\n## B');
    assert.equal(div.firstChild.tagName, 'H2');
    assert.equal(div.lastChild.tagName, 'H3');
  });
});
