// 仅测试版：把替身流 ID 映射为“播放固定测试音频”的媒体流（WebAudio，播完后保持静音而不结束）。
const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (c) => {
  const id = c && c.audio && c.audio.mandatory && c.audio.mandatory.chromeMediaSourceId;
  if (id !== 'wv4u-test-stream') return orig(c);
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await (await fetch(chrome.runtime.getURL('test-media/speech16k.wav'))).arrayBuffer());
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  await ctx.resume();
  src.start();
  globalThis.__testAudioStartedAt = Date.now();
  return dest.stream;
};
