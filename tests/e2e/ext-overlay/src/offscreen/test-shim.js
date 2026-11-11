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
  if (!c.video) return dest.stream;
  // 请求画面时：用画布生成每 2 秒变化一次的测试画面（模拟幻灯片翻页）
  const cv = document.createElement('canvas');
  cv.width = 640;
  cv.height = 360;
  const g = cv.getContext('2d');
  const t0 = Date.now();
  const draw = () => {
    const k = Math.floor((Date.now() - t0) / 2000);
    g.fillStyle = `hsl(${(k * 67) % 360} 60% 45%)`;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff';
    g.font = 'bold 64px sans-serif';
    g.fillText(`Slide ${k + 1}`, 60, 200);
  };
  draw();
  setInterval(draw, 250);
  const vs = cv.captureStream(4);
  return new MediaStream([...dest.stream.getAudioTracks(), ...vs.getVideoTracks()]);
};
