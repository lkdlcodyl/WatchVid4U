import { test, describe, assert } from './harness.js';
import { wavHeader, floatToInt16, frameRms, wavBlobForRange, wavBlobAll, testToneWav } from '../../extension/src/shared/wav.js';

function chunk(startSample, n, val) {
  const f = new Float32Array(n).fill(val);
  return { startSample, sampleCount: n, blob: new Blob([floatToInt16(f).buffer]) };
}

describe('wav', () => {
  test('文件头字段', () => {
    const v = new DataView(wavHeader(16000));
    assert.equal(v.getUint32(4, true), 36 + 32000);
    assert.equal(v.getUint16(22, true), 1);
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getUint32(40, true), 32000);
  });
  test('跨块区间拼接长度精确', async () => {
    const cs = [chunk(0, 32000, 0.1), chunk(32000, 32000, 0.2), chunk(64000, 10000, 0.3)];
    const b = wavBlobForRange(cs, 16000, 70000);
    assert.equal(b.size, 44 + (70000 - 16000) * 2);
    const buf = new DataView(await b.arrayBuffer());
    assert.equal(buf.getInt16(44, true), Math.trunc(Math.fround(0.1) * 0x7fff));
    assert.equal(buf.getInt16(44 + 16000 * 2, true), Math.trunc(Math.fround(0.2) * 0x7fff));
  });
  test('真实解码：浏览器得到正确时长（可拖动、非未知时长）', async () => {
    const cs = [chunk(0, 32000, 0.05), chunk(32000, 24000, 0.05)];
    const ctx = new OfflineAudioContext(1, 16000, 16000);
    const audio = await ctx.decodeAudioData(await wavBlobAll(cs).arrayBuffer());
    assert.ok(Math.abs(audio.duration - 3.5) < 0.01, `duration=${audio.duration}`);
  });
  test('rms 帧与削波', () => {
    const r = frameRms(new Float32Array(3200).fill(0.5), 1600);
    assert.deepEqual(r, [0.5, 0.5]);
    const i = floatToInt16(new Float32Array([2, -2, 0]));
    assert.deepEqual(Array.from(i), [32767, -32768, 0]);
  });
  test('测试音为固定材料', () => {
    assert.equal(testToneWav(1).size, 44 + 32000);
  });
});
