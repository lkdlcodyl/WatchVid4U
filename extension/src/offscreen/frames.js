// 录制时定时截取标签页画面（与录音同一个 tabCapture 流）。
// 只在录音时间轴前进时截取（视频暂停、广告期间不截）；黑屏与重复画面不保存，缩小后以 JPEG 存入本机。
import { addFrame } from '../shared/db.js';
import { isBlankFrame, isDuplicateFrame } from '../shared/frames.js';

const MAX_WIDTH = 768;
const QUALITY = 0.7;
const THUMB_W = 32;
const THUMB_H = 18;

export class FrameGrabber {
  constructor({ track, materialId, intervalSec }) {
    this.track = track;
    this.materialId = materialId;
    this.intervalSec = Math.max(5, intervalSec || 30);
    this.lastT = null;
    this.prevThumb = null;
    this.busy = false;
    this.seq = 0;
    this.stats = { count: 0, bytes: 0, blank: 0, duplicate: 0, errors: 0 };
    this.chain = Promise.resolve();
  }

  async start() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream([this.track]);
    this.video = v;
    await v.play().catch(() => {});
    this.canvas = document.createElement('canvas');
    this.thumb = document.createElement('canvas');
    this.thumb.width = THUMB_W;
    this.thumb.height = THUMB_H;
  }

  /** 每秒由录音模块调用一次；t 为录音时间轴（秒） */
  tick(t) {
    if (this.busy || this.stopped) return;
    if (this.lastT == null ? t < 1 : t - this.lastT < this.intervalSec) return;
    this.lastT = t;
    this.busy = true;
    this.chain = this.chain
      .then(() => this.grab(t))
      .catch(() => {
        this.stats.errors++;
      })
      .finally(() => {
        this.busy = false;
      });
  }

  async grab(t) {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const tc = this.thumb.getContext('2d', { willReadFrequently: true });
    tc.drawImage(v, 0, 0, THUMB_W, THUMB_H);
    const px = tc.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const gray = new Uint8Array(THUMB_W * THUMB_H);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
    if (isBlankFrame(gray)) {
      this.stats.blank++;
      return;
    }
    if (this.prevThumb && isDuplicateFrame(this.prevThumb, gray)) {
      this.stats.duplicate++;
      return;
    }
    const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', QUALITY));
    if (!blob) return;
    await addFrame({ materialId: this.materialId, seq: this.seq++, t: Math.round(t * 10) / 10, blob, w, h, bytes: blob.size });
    this.prevThumb = gray;
    this.stats.count++;
    this.stats.bytes += blob.size;
  }

  async stop() {
    this.stopped = true;
    await this.chain.catch(() => {});
    try {
      this.video.pause();
      this.video.srcObject = null;
    } catch {
      /* ignore */
    }
    return { ...this.stats, intervalSec: this.intervalSec };
  }
}
