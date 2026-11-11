import { test, describe, assert } from './harness.js';
import { grayStats, isBlankFrame, frameDiff, isDuplicateFrame, selectFrames, fmtTs } from '../../extension/src/shared/frames.js';
import { buildNoteMessages } from '../../extension/src/shared/prompts.js';
import { composeTranscript, textForLlm } from '../../extension/src/shared/transcript.js';

const fill = (n, v) => new Uint8Array(n).fill(v);

describe('frames', () => {
  test('黑屏判断：近乎全黑且无内容才跳过', () => {
    assert.ok(isBlankFrame(fill(576, 3)), '全黑');
    assert.equal(isBlankFrame(fill(576, 120)), false, '灰色画面');
    const darkText = fill(576, 5);
    for (let i = 0; i < 576; i += 7) darkText[i] = 230; // 黑底白字（如深色幻灯片）
    assert.equal(isBlankFrame(darkText), false, '黑底有内容不算黑屏');
    assert.ok(Math.abs(grayStats(fill(10, 50)).mean - 50) < 1e-9);
  });
  test('重复画面判断：几乎相同才跳过', () => {
    const a = fill(576, 100);
    const b = fill(576, 102);
    const c = fill(576, 160);
    assert.ok(isDuplicateFrame(a, b));
    assert.equal(isDuplicateFrame(a, c), false);
    assert.equal(frameDiff(a, new Uint8Array(10)), 255, '尺寸不同视为不同');
  });
  test('挑选画面：排除广告时段，均匀抽取并保留首尾', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({ seq: i, t: i * 10 }));
    const sel = selectFrames(frames, 5, [[100, 150]]);
    assert.equal(sel.length, 5);
    assert.equal(sel[0].t, 0);
    assert.equal(sel[sel.length - 1].t, 390);
    assert.ok(sel.every((f) => f.t < 100 || f.t > 150), '不含广告时段');
    assert.equal(selectFrames(frames.slice(0, 3), 10).length, 3, '不足上限时全部使用');
    assert.equal(selectFrames(frames, 0).length, 0);
    assert.equal(fmtTs(65), '1:05');
    assert.equal(fmtTs(3725), '1:02:05');
  });
  test('笔记请求：附带画面时为“文字 + 图片”多模态内容，并说明用法', () => {
    const frames = [
      { t: 5, label: '0:05', dataUrl: 'data:image/jpeg;base64,AAA' },
      { t: 35, label: '0:35', dataUrl: 'data:image/jpeg;base64,BBB' },
    ];
    const msgs = buildNoteMessages({ transcript: '[0:00] 第一段', mode: 'concise', platform: 'youtube', ignorePromo: false, frames, timed: true });
    assert.match(msgs[0].content, /【视频画面】.*2 张/);
    const parts = msgs[1].content;
    assert.ok(Array.isArray(parts));
    assert.equal(parts.filter((p) => p.type === 'image_url').length, 2);
    assert.equal(parts[1].text, '画面 @ 0:05');
    assert.equal(parts[2].image_url.url, 'data:image/jpeg;base64,AAA');
    const plain = buildNoteMessages({ transcript: 't', mode: 'concise', platform: 'youtube', ignorePromo: false });
    assert.equal(typeof plain[1].content, 'string', '无画面时保持纯文本请求');
    assert.equal(plain[0].content.includes('【视频画面】'), false);
  });
  test('附带画面时逐字稿带时间标记，便于与画面对应', () => {
    const segs = Array.from({ length: 8 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `第${i + 1}句。` }));
    const tr = composeTranscript({ plain: segs.map((s) => s.text).join(''), source: 'stt', segments: segs });
    const r = textForLlm({ transcript: tr, audio: { adIntervals: [] } }, { timestamps: true });
    assert.ok(r.timed);
    assert.match(r.text, /^\[0:00\] 第1句。/);
    assert.match(r.text, /\[0:30\] 第4句。/);
    assert.equal(textForLlm({ transcript: tr, audio: { adIntervals: [] } }).text, tr.effective, '不附画面时不变');
  });
});
