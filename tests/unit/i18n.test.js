import { test, describe, assert } from './harness.js';
import { t, setLang, resolveLang, getLang } from '../../extension/src/shared/i18n.js';
import { describeError } from '../../extension/src/shared/errors.js';
import { platformLabel } from '../../extension/src/shared/format.js';

describe('i18n', () => {
  test('中文：原样返回并替换占位符', () => {
    setLang('zh');
    assert.equal(t('开始录制'), '开始录制');
    assert.equal(t('时长 {d}', { d: '1:00' }), '时长 1:00');
  });
  test('英文：查词典并替换占位符；缺少译文时回退中文', () => {
    setLang('en');
    try {
      assert.equal(t('开始录制'), 'Start recording');
      assert.equal(t('已有 {n} 个标签页在录制，达到同时录制上限（{max} 个）。请等其中一个录完，或在设置中调高上限。', { n: 3, max: 3 }).startsWith('3 tabs are already recording'), true);
      assert.equal(t('词典里没有的文字'), '词典里没有的文字');
      assert.equal(platformLabel('bilibili'), 'Bilibili');
      assert.equal(describeError({ code: 'http_auth', stage: 'stt', detail: '上限 3 个' }).startsWith('[Speech-to-text] The service rejected'), true);
    } finally {
      setLang('zh');
    }
    assert.equal(getLang(), 'zh');
  });
  test('跟随浏览器：中文浏览器用中文，其他语言用英文', () => {
    assert.equal(resolveLang('auto', 'zh-CN'), 'zh');
    assert.equal(resolveLang('auto', 'zh-TW'), 'zh');
    assert.equal(resolveLang('auto', 'en-US'), 'en');
    assert.equal(resolveLang('auto', 'ja'), 'en');
    assert.equal(resolveLang('zh', 'en-US'), 'zh');
    assert.equal(resolveLang('en', 'zh-CN'), 'en');
  });
});
