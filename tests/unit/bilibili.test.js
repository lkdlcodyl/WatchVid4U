import { test, describe, assert } from './harness.js';
import { parseBiliUrl, biliVideoKey, classifyTrack, chooseTrack, parseSubtitleBody, extractTracks, pickPage, fetchBiliSubtitle, subtitleText, isAllowedBiliUrl } from '../../extension/src/shared/bilibili.js';

const policy = { acceptAuto: true, acceptUnknown: true, allowNonChinese: false, useLogin: false };
const body = (lines) => ({ body: lines.map(([f, t, c]) => ({ from: f, to: t, content: c })) });

describe('bilibili', () => {
  test('URL 解析：BV/av/分P/列表/番剧', () => {
    assert.deepEqual(parseBiliUrl('https://www.bilibili.com/video/BV1xx411c7mD/?p=3&spm=1'), { kind: 'video', bvid: 'BV1xx411c7mD', aid: null, p: 3 });
    assert.equal(parseBiliUrl('https://www.bilibili.com/video/av170001').aid, '170001');
    assert.equal(parseBiliUrl('https://www.bilibili.com/list/123?bvid=BV1xx411c7mD').bvid, 'BV1xx411c7mD');
    assert.equal(parseBiliUrl('https://www.bilibili.com/bangumi/play/ep1').kind, 'unsupported');
    assert.equal(parseBiliUrl('https://example.com/video/BV1xx411c7mD'), null);
    assert.equal(biliVideoKey('https://www.bilibili.com/video/BV1xx411c7mD?t=30'), 'bili:BV1xx411c7mD:p1');
  });
  test('字幕类型：自动/人工/未知如实区分', () => {
    assert.equal(classifyTrack({ lan: 'ai-zh', type: 1 }), 'auto');
    assert.equal(classifyTrack({ lan: 'zh-CN', type: 0, ai_type: 0 }), 'manual');
    assert.equal(classifyTrack({ lan: 'zh-CN' }), 'unknown');
    assert.equal(classifyTrack({ lan: 'zh-CN', type: 0, ai_type: 1 }), 'auto');
  });
  test('选择策略：中文优先、人工优先、遵守开关', () => {
    const tracks = [
      { lan: 'en-US', kind: 'manual', url: 'u1' },
      { lan: 'ai-zh', kind: 'auto', url: 'u2' },
      { lan: 'zh-CN', kind: 'manual', url: 'u3' },
    ];
    assert.equal(chooseTrack(tracks, policy).url, 'u3');
    assert.equal(chooseTrack(tracks.slice(0, 2), policy).url, 'u2');
    assert.throwsCode(() => chooseTrack(tracks.slice(0, 2), { ...policy, acceptAuto: false }), 'sub_policy_rejected');
    assert.throwsCode(() => chooseTrack([tracks[0]], policy), 'sub_policy_rejected');
    assert.equal(chooseTrack([tracks[0]], { ...policy, allowNonChinese: true }).url, 'u1');
    assert.throwsCode(() => chooseTrack([], policy), 'sub_none');
    assert.throwsCode(() => chooseTrack([{ lan: 'ai-zh', kind: 'auto', url: '' }], policy), 'sub_need_login');
  });
  test('正文校验：空、坏数据、时长不符、不完整', () => {
    assert.throwsCode(() => parseSubtitleBody({}, 10), 'sub_bad_data');
    assert.throwsCode(() => parseSubtitleBody(body([[0, 1, '  ']]), 10), 'sub_empty');
    assert.throwsCode(() => parseSubtitleBody(body([[0, 1, 'a'], [500, 600, 'b']]), 100), 'sub_mismatch');
    assert.throwsCode(() => parseSubtitleBody(body([[0, 30, 'a']]), 600), 'sub_incomplete');
    assert.throwsCode(() => parseSubtitleBody(body([[5, 2, 'a']]), 10), 'sub_bad_data');
    const ok = parseSubtitleBody(body([[0, 280, 'a'], [281, 290, 'b']]), 300);
    assert.equal(ok.lines.length, 2);
  });
  test('接口身份核对：分P不一致拒绝', () => {
    assert.throwsCode(() => extractTracks({ cid: 2, subtitle: { subtitles: [] } }, { cid: 1 }), 'sub_mismatch');
    assert.throwsCode(() => pickPage({ bvid: 'BV1aaaaaaaaa', pages: [] }, { bvid: 'BV1bbbbbbbbb', p: 1 }), 'sub_mismatch');
    assert.equal(pickPage({ bvid: 'BV1aaaaaaaaa', aid: 1, pages: [{ page: 1, cid: 10, duration: 5 }, { page: 2, cid: 11, duration: 6 }] }, { bvid: 'BV1aaaaaaaaa', p: 2 }).cid, 11);
  });
  test('只允许访问 B站接口与字幕域名', () => {
    assert.ok(isAllowedBiliUrl('https://api.bilibili.com/x/player/v2'));
    assert.ok(isAllowedBiliUrl('https://aisubtitle.hdslb.com/bfs/x.json'));
    assert.ok(!isAllowedBiliUrl('https://evil.com/x'));
    assert.ok(!isAllowedBiliUrl('http://api.bilibili.com/x'));
  });
  test('完整流程（注入的传输）：成功、无字幕、换片', async () => {
    const view = { code: 0, data: { bvid: 'BV1aaaaaaaaa', aid: 5, cid: 50, title: 'T', duration: 20, pages: [{ page: 1, cid: 50, duration: 20, part: 'P' }] } };
    const player = (subs) => ({ code: 0, data: { aid: 5, bvid: 'BV1aaaaaaaaa', cid: 50, subtitle: { subtitles: subs } } });
    const sub = body([[0, 5, '第一句'], [5.2, 19, '第二句']]);
    const mk = (subs) => async (u) => (u.includes('/view') ? view : u.includes('/player/') ? player(subs) : sub);
    const ok = await fetchBiliSubtitle({ href: 'https://www.bilibili.com/video/BV1aaaaaaaaa', fetchJson: mk([{ lan: 'ai-zh', lan_doc: '中文', subtitle_url: '//aisubtitle.hdslb.com/x.json', type: 1 }]), policy, checkIdentity: async () => {} });
    assert.equal(ok.text, '第一句 第二句');
    assert.equal(ok.track.kind, 'auto');
    await assert.rejectsCode(fetchBiliSubtitle({ href: 'https://www.bilibili.com/video/BV1aaaaaaaaa', fetchJson: mk([]), policy, checkIdentity: async () => {} }), 'sub_none');
    let n = 0;
    await assert.rejectsCode(
      fetchBiliSubtitle({ href: 'https://www.bilibili.com/video/BV1aaaaaaaaa', fetchJson: mk([{ lan: 'ai-zh', subtitle_url: '//a.hdslb.com/x', type: 1 }]), policy, checkIdentity: async () => { if (++n === 2) throw Object.assign(new Error(), { code: 'sub_identity_changed' }); } }),
      'sub_identity_changed',
    );
  });
  test('字幕转文本按停顿分段、不臆造标点', () => {
    const t = subtitleText([{ from: 0, to: 1, content: '甲' }, { from: 1.1, to: 2, content: '乙' }, { from: 5, to: 6, content: '丙' }]);
    assert.equal(t, '甲 乙\n\n丙');
  });
});
