// 极简浏览器内测试框架（项目环境没有 Node，单测在无头 Chrome 中运行）。
const tests = [];
let current = '';

export function test(name, fn) {
  tests.push({ name: `${current}${name}`, fn });
}

export function describe(name, fn) {
  const prev = current;
  current = `${prev}${name} › `;
  fn();
  current = prev;
}

function fmt(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const assert = {
  ok(v, msg = '') {
    if (!v) throw new Error(`expected truthy ${msg}`);
  },
  equal(a, b, msg = '') {
    if (a !== b) throw new Error(`expected ${fmt(b)}, got ${fmt(a)} ${msg}`);
  },
  deepEqual(a, b, msg = '') {
    if (fmt(a) !== fmt(b)) throw new Error(`expected ${fmt(b)}, got ${fmt(a)} ${msg}`);
  },
  match(s, re, msg = '') {
    if (!re.test(String(s))) throw new Error(`expected ${fmt(s)} to match ${re} ${msg}`);
  },
  notMatch(s, re, msg = '') {
    if (re.test(String(s))) throw new Error(`expected ${fmt(s)} not to match ${re} ${msg}`);
  },
  async rejectsCode(p, code, msg = '') {
    try {
      await (typeof p === 'function' ? p() : p);
    } catch (e) {
      if (e.code !== code) throw new Error(`expected error code ${code}, got ${e.code} (${e.message}) ${msg}`);
      return e;
    }
    throw new Error(`expected rejection with ${code} ${msg}`);
  },
  throwsCode(fn, code, msg = '') {
    try {
      fn();
    } catch (e) {
      if (e.code !== code) throw new Error(`expected error code ${code}, got ${e.code} (${e.message}) ${msg}`);
      return e;
    }
    throw new Error(`expected throw with ${code} ${msg}`);
  },
};

export async function run() {
  const results = [];
  for (const t of tests) {
    const t0 = performance.now();
    try {
      await t.fn();
      results.push({ name: t.name, ok: true, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      results.push({ name: t.name, ok: false, error: String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  window.__results = { total: results.length, failed, results };
  const pre = document.getElementById('out');
  if (pre) pre.textContent = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : '\n     ' + r.error}`).join('\n') + `\n\n${results.length - failed}/${results.length} passed`;
  return window.__results;
}
