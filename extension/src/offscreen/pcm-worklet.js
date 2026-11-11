// AudioWorklet：把（已由节点下混为单声道的）输入按约 0.2 s 打包发给主线程。
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(3200);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
    };
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage(this.buf.slice(0, this.n));
      this.n = 0;
    }
    this.port.postMessage('flushed');
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice());
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
