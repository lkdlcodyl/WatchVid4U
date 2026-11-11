import { test, describe, assert } from './harness.js';
import { videoKeyFromUrl, detectPlatform } from '../../extension/src/shared/platform.js';

const D = globalThis.WV4U_DETECT;

describe('detector', () => {
  test('内容脚本与后台的视频身份键一致', () => {
    const urls = [
      'https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=10',
      'https://www.bilibili.com/video/av170001',
      'https://www.bilibili.com/list/1?bvid=BV1xx411c7mD',
      'https://www.youtube.com/watch?v=abc123&t=5',
      'https://www.youtube.com/shorts/xyz',
      'https://www.douyin.com/video/7000000000000000001',
      'https://www.douyin.com/jingxuan?modal_id=7000000000000000009',
      'https://www.douyin.com/',
      'https://example.com/a/b?x=1',
    ];
    for (const u of urls) {
      assert.equal(D.videoKeyOf(u), videoKeyFromUrl(u), u);
      assert.equal(D.platformOf(u), detectPlatform(u), u);
    }
  });
  test('YouTube 结束判定：广告结束/正文结束/未知', () => {
    assert.equal(D.judgeEnd({ platform: 'youtube', adState: 'ad', duration: 15, currentTime: 15 }), 'ad-end');
    assert.equal(D.judgeEnd({ platform: 'youtube', adState: 'content', duration: 300, currentTime: 300, contentDuration: 300 }), 'content-end');
    assert.equal(D.judgeEnd({ platform: 'youtube', adState: 'unknown', duration: 300, currentTime: 300 }), 'unknown');
    assert.equal(D.judgeEnd({ platform: 'youtube', adState: 'content', duration: 15, currentTime: 15, contentDuration: 300 }), 'unknown');
    assert.equal(D.judgeEnd({ platform: 'bilibili', adState: 'content', duration: 100, currentTime: 50 }), 'unknown');
    assert.equal(D.judgeEnd({ platform: 'bilibili', adState: 'content', duration: 100, currentTime: 99.9 }), 'content-end');
  });
  test('循环检测：需接近结尾→回到开头且无用户操作', () => {
    assert.ok(D.isLoopWrap(59.5, 0.2, 60, 5000));
    assert.ok(!D.isLoopWrap(59.5, 0.2, 60, 500), '用户刚操作过（主动重播）');
    assert.ok(!D.isLoopWrap(30, 0.2, 60, 5000), '中途拖到开头不是循环');
  });
  test('广告 DOM 状态识别', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div id="movie_player" class="html5-video-player ad-showing"></div>';
    const doc = document.implementation.createHTMLDocument('x');
    doc.body.appendChild(doc.importNode(host.firstChild, true));
    assert.equal(D.youtubeAdState(doc), 'ad');
    doc.getElementById('movie_player').classList.remove('ad-showing');
    assert.equal(D.youtubeAdState(doc), 'content');
    assert.equal(D.youtubeAdState(document.implementation.createHTMLDocument('y')), 'unknown');
  });
  test('输入框、评论与可编辑区不响应单键', () => {
    const mk = (html) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstChild;
    };
    assert.ok(D.isEditableTarget(mk('<input type="text">')));
    assert.ok(D.isEditableTarget(mk('<textarea></textarea>')));
    assert.ok(!D.isEditableTarget(mk('<input type="checkbox">')));
    const ce = mk('<div contenteditable="true"><span>x</span></div>');
    document.body.appendChild(ce);
    assert.ok(D.isEditableTarget(ce.firstChild));
    ce.remove();
    assert.ok(!D.isEditableTarget(mk('<button>x</button>')));
  });
  test('标题清理', () => {
    assert.equal(D.cleanTitle('视频标题_哔哩哔哩_bilibili', 'bilibili'), '视频标题');
    assert.equal(D.cleanTitle('(3) Talk - YouTube', 'youtube'), 'Talk');
  });
});
