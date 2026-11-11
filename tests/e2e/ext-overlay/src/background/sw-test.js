// 仅测试版：tabCapture 需要用户点击工具栏图标才能授权，无法自动化。
// 这里用替身流 ID 代替（offscreen 替身会用固定测试音频生成媒体流）；
// 设置 globalThis.__wv4uRealCapture = true 时调用真实 API（用于验证未授权时的提示路径）。
import '../background/sw.js';
const real = chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
const fake = async (opts) => (globalThis.__wv4uRealCapture ? real(opts) : 'wv4u-test-stream');
try {
  chrome.tabCapture.getMediaStreamId = fake;
} catch (e) {
  Object.defineProperty(chrome.tabCapture, 'getMediaStreamId', { value: fake, configurable: true });
}
