import { test, describe, assert } from './harness.js';
import { mergeSlices, buildSpeakerTranscript, composeTranscript, textForLlm, splitLongText } from '../../extension/src/shared/transcript.js';

describe('transcript', () => {
  test('分片按序合并为绝对时间，并在停顿处分段', () => {
    const r = mergeSlices([
      { index: 1, offsetSec: 60, segments: [{ start: 0, end: 3, text: '第二片。' }] },
      { index: 0, offsetSec: 0, segments: [{ start: 0, end: 2, text: '第一句。' }, { start: 10, end: 12, text: '停顿后。' }] },
    ]);
    assert.equal(r.plain, '第一句。\n\n停顿后。\n\n第二片。');
    assert.equal(r.segments[2].start, 60);
  });
  test('无分段时直接拼接文本，不丢片', () => {
    const r = mergeSlices([{ index: 0, offsetSec: 0, text: 'A。', segments: null }, { index: 1, offsetSec: 30, text: 'B。', segments: null }, { index: 2, offsetSec: 60, text: '', segments: [], silent: true }]);
    assert.equal(r.plain, 'A。\n\nB。');
  });
  test('长文本按句切段', () => {
    const t = '这是一个句子。'.repeat(120);
    const parts = splitLongText(t);
    assert.ok(parts.length > 1);
    assert.equal(parts.join(''), t);
  });
  test('说话人：多人且可靠才生成分段稿；不确定的不猜', () => {
    const segs = [
      { start: 0, end: 2, text: '你好。', speaker: 'S1' },
      { start: 2, end: 4, text: '欢迎。', speaker: 'S1' },
      { start: 4, end: 6, text: '谢谢。', speaker: 'S0' },
      { start: 6, end: 7, text: '嗯。', speaker: null },
    ];
    const s = buildSpeakerTranscript(segs, { count: 2, reliable: true });
    assert.equal(s, '【说话人 A】你好。欢迎。\n\n【说话人 B】谢谢。\n\n【说话人未确认】嗯。');
    assert.equal(buildSpeakerTranscript(segs, { count: 2, reliable: false }), null);
    assert.equal(buildSpeakerTranscript(segs, { count: 1, reliable: true }), null);
    assert.equal(buildSpeakerTranscript(segs, null), null);
  });
  test('唯一有效逐字稿：多人可靠时用分段稿，否则普通稿', () => {
    const a = composeTranscript({ plain: 'P', speaker: 'S', source: 'stt' });
    assert.equal(a.effective, 'S');
    assert.equal(a.kind, 'speaker');
    const b = composeTranscript({ plain: 'P', speaker: null, source: 'stt' });
    assert.equal(b.effective, 'P');
    assert.equal(b.kind, 'plain');
  });
  test('LLM 输入：有广告检测证据时插入标记，但不改保存的逐字稿', () => {
    const tr = composeTranscript({ plain: '正文一。广告词。正文二。', source: 'stt', segments: [{ start: 0, end: 5, text: '正文一。' }, { start: 5, end: 20, text: '广告词。' }, { start: 20, end: 25, text: '正文二。' }] });
    const m = { transcript: tr, audio: { adIntervals: [[5, 20]] } };
    const r = textForLlm(m);
    assert.ok(r.adEvidence);
    assert.match(r.text, /\[平台插播广告时段开始（播放器检测）\]广告词。\[平台插播广告时段结束\]/);
    assert.equal(m.transcript.effective, '正文一。广告词。正文二。');
    assert.equal(textForLlm({ transcript: tr, audio: { adIntervals: [] } }).adEvidence, false);
  });
});
