import { test, describe, assert } from './harness.js';
import { planSlices, quietestCut, trimTrailingSilence, isSilent, SILENCE_RMS } from '../../extension/src/shared/chunking.js';

// 合成 rms：每 0.1 s 一帧；speech 段 0.05，pause 段 0.0005
function synth(pattern) {
  const out = [];
  for (const [sec, kind] of pattern) for (let i = 0; i < Math.round(sec * 10); i++) out.push(kind === 's' ? 0.05 : kind === 'n' ? 0.02 : 0.0005);
  return out;
}

describe('chunking', () => {
  test('短音频只有一片', () => {
    const rms = synth([[30, 's']]);
    const s = planSlices(rms, 30 * 16000, 600);
    assert.equal(s.length, 1);
    assert.equal(s[0].start, 0);
    assert.equal(s[0].end, 30 * 16000);
  });
  test('长音频在静音处切分，连续覆盖且不超长', () => {
    const pat = [];
    for (let i = 0; i < 20; i++) pat.push([17, 's'], [1, 'p']); // 每 18 s 一个 1 s 停顿
    const rms = synth(pat);
    const total = rms.length * 1600;
    const s = planSlices(rms, total, 60);
    assert.ok(s.length >= 6 && s.length <= 8, `slices=${s.length}`);
    for (let i = 0; i < s.length; i++) {
      assert.ok(s[i].end - s[i].start <= 60 * 16000, '不超过单片上限');
      if (i) assert.equal(s[i].start, s[i - 1].end, '首尾相接、无重叠无漏洞');
      if (i < s.length - 1) {
        const f = s[i].end / 1600;
        assert.ok(rms[f] < SILENCE_RMS || rms[f - 1] < SILENCE_RMS, `切点 ${f} 在静音处`);
      }
    }
    assert.equal(s[0].start, 0);
    assert.equal(s[s.length - 1].end, total);
  });
  test('没有静音时在目标边界附近切分', () => {
    const rms = synth([[200, 's']]);
    const s = planSlices(rms, rms.length * 1600, 60);
    assert.equal(s.length, 4);
    assert.ok(s.every((x) => x.end - x.start <= 60 * 16000));
  });
  test('完全静音的片段被标记（不发送）', () => {
    const rms = synth([[50, 's'], [100, 'p'], [50, 's']]);
    const s = planSlices(rms, rms.length * 1600, 60);
    assert.ok(s.some((x) => x.silent), '有静音片段');
    assert.ok(s.some((x) => !x.silent));
  });
  test('quietestCut 选择最安静窗口', () => {
    const rms = synth([[10, 's'], [0.6, 'p'], [10, 's']]);
    const c = quietestCut(rms, 50, 200);
    assert.ok(c >= 100 && c <= 106, `cut=${c}`);
  });
  test('尾部长静音被裁剪但保留余量', () => {
    const rms = synth([[10, 's'], [30, 'p']]);
    const t = trimTrailingSilence(rms, { start: 0, end: rms.length * 1600 });
    assert.ok(t.end <= (100 + 11) * 1600 && t.end >= 100 * 1600, `end=${t.end / 1600}`);
    assert.ok(isSilent(rms, 100, 400));
  });
});
