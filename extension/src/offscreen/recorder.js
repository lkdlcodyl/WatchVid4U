// 标签页音频录制：tabCapture 流 → 16 kHz 单声道 PCM → 每约 2 秒落盘一块。
// 支持多个标签页同时录制：每路录音以 materialId 区分，互不影响。
// 监听（让用户听到声音）走独立的 AudioContext，只改变输出增益，不影响录音数据。
import { addChunk, updateMaterial } from '../shared/db.js';
import { floatToInt16, frameRms, SAMPLE_RATE } from '../shared/wav.js';
import { FrameGrabber } from './frames.js';

const CHUNK_SAMPLES = SAMPLE_RATE * 2;
const SILENCE_LEVEL = 0.003;

export class TabRecorder {
  constructor(emit) {
    this.emit = emit; // (type, payload) => void
    this.recs = new Map(); // materialId -> 录音状态
  }

  get busy() {
    return this.recs.size > 0;
  }

  ids() {
    return [...this.recs.keys()];
  }

  /** frames: {enabled, intervalSec}：同时定时截取画面（与音频共用同一个授权流） */
  async start({ streamId, materialId, monitor, frames = null }) {
    if (this.recs.has(materialId)) throw Object.assign(new Error('busy'), { code: 'task_busy' });
    const wantVideo = !!(frames && frames.enabled);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: wantVideo ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 2 } } : false,
      });
    } catch (e) {
      throw Object.assign(new Error(String(e && e.message)), { code: 'capture_failed', detail: e && e.name ? e.name : '' });
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink).connect(ctx.destination);
    // 监听：原始采样率播放
    const monCtx = new AudioContext({ latencyHint: 'interactive' });
    const monSrc = monCtx.createMediaStreamSource(stream);
    const monGain = monCtx.createGain();
    monGain.gain.value = monitor ? 1 : 0;
    monSrc.connect(monGain).connect(monCtx.destination);
    await Promise.allSettled([ctx.resume(), monCtx.resume()]);
    if (ctx.state !== 'running') {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      monCtx.close();
      throw Object.assign(new Error('audio context not running'), { code: 'capture_failed', detail: 'AudioContext 未能启动' });
    }

    const a = {
      materialId,
      stream,
      ctx,
      node,
      monCtx,
      monGain,
      pending: [],
      pendingSamples: 0,
      seq: 0,
      writtenSamples: 0,
      bytes: 0,
      gated: false,
      writeChain: Promise.resolve(),
      silentSec: 0,
      lastLevelEmit: 0,
      levelAcc: 0,
      levelN: 0,
      adOpen: null,
      adIntervals: [],
      writeError: null,
      ended: false,
      grabber: null,
    };
    const vtrack = wantVideo ? stream.getVideoTracks()[0] : null;
    if (vtrack) {
      a.grabber = new FrameGrabber({ track: vtrack, materialId, intervalSec: frames.intervalSec });
      await a.grabber.start().catch(() => (a.grabber = null));
    }
    this.recs.set(materialId, a);
    node.port.onmessage = (e) => {
      if (e.data === 'flushed') {
        a.onFlushed && a.onFlushed();
        return;
      }
      this.onSamples(a, e.data);
    };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.recs.get(materialId) === a && !a.ended) this.emit('rec-track-ended', { materialId });
    });
    return { sampleRate: SAMPLE_RATE };
  }

  onSamples(a, f32) {
    // 电平统计（不论是否门控）
    let peak = 0;
    for (let i = 0; i < f32.length; i += 4) peak = Math.max(peak, Math.abs(f32[i]));
    a.levelAcc = Math.max(a.levelAcc, peak);
    if (a.gated) return;
    a.pending.push(f32);
    a.pendingSamples += f32.length;
    const now = Date.now();
    if (now - a.lastLevelEmit >= 1000) {
      const sec = (now - (a.lastLevelEmit || now)) / 1000;
      if (a.levelAcc < SILENCE_LEVEL) a.silentSec += sec || 1;
      else a.silentSec = 0;
      a.lastLevelEmit = now;
      const tNow = (a.writtenSamples + a.pendingSamples) / SAMPLE_RATE;
      this.emit('rec-level', { materialId: a.materialId, seconds: tNow, silentSec: Math.round(a.silentSec), level: Math.round(a.levelAcc * 1000) / 1000 });
      a.levelAcc = 0;
      // 截帧跟随录音时间轴：暂停（门控）时不会走到这里；广告期间不截
      if (a.grabber && a.adOpen == null) a.grabber.tick(tNow);
    }
    if (a.pendingSamples >= CHUNK_SAMPLES) this.writeChunk(a);
  }

  writeChunk(a) {
    if (!a.pendingSamples) return a.writeChain;
    const f32 = new Float32Array(a.pendingSamples);
    let o = 0;
    for (const p of a.pending) {
      f32.set(p, o);
      o += p.length;
    }
    a.pending = [];
    a.pendingSamples = 0;
    const startSample = a.writtenSamples;
    a.writtenSamples += f32.length;
    const seq = a.seq++;
    const pcm = floatToInt16(f32);
    const blob = new Blob([pcm.buffer], { type: 'application/octet-stream' });
    const rms = frameRms(f32, 1600);
    const bytes = pcm.byteLength;
    a.bytes += bytes;
    const samples = a.writtenSamples;
    const totalBytes = a.bytes;
    a.writeChain = a.writeChain
      .then(() => addChunk({ materialId: a.materialId, seq, startSample, sampleCount: f32.length, blob, rms, bytes }))
      .then(() =>
        updateMaterial(
          a.materialId,
          (m) => {
            m.audio.samples = samples;
            m.audio.bytes = totalBytes;
            m.audio.chunks = seq + 1;
            return m;
          },
          { silent: seq % 5 !== 0 },
        ),
      )
      .catch((e) => {
        a.writeError = e;
        this.emit('rec-write-error', { materialId: a.materialId, code: e && e.name === 'QuotaExceededError' ? 'quota' : 'db' });
      });
    return a.writeChain;
  }

  setMonitor(materialId, on) {
    const a = this.recs.get(materialId);
    if (a) a.monGain.gain.setTargetAtTime(on ? 1 : 0, a.monCtx.currentTime, 0.02);
  }

  /** 视频暂停时门控写入（录音范围如实对应实际播放内容） */
  setGate(materialId, paused) {
    const a = this.recs.get(materialId);
    if (!a) return;
    a.gated = !!paused;
  }

  /** 记录平台广告时段（以录音时间轴计） */
  setAd(materialId, isAd) {
    const a = this.recs.get(materialId);
    if (!a) return;
    const t = (a.writtenSamples + a.pendingSamples) / SAMPLE_RATE;
    if (isAd && a.adOpen == null) a.adOpen = t;
    else if (!isAd && a.adOpen != null) {
      if (t - a.adOpen > 0.5) a.adIntervals.push([round1(a.adOpen), round1(t)]);
      a.adOpen = null;
    }
  }

  /**
   * 停止并落盘最后一段。tailMs：结束后继续收集的尾音时间（补足音频管线延迟，保住尾句）。
   * 返回 {samples, bytes, adIntervals, writeError}
   */
  async stop(materialId, { tailMs = 0 } = {}) {
    const a = this.recs.get(materialId);
    if (!a) return null;
    a.ended = true;
    if (tailMs > 0 && !a.gated) await new Promise((r) => setTimeout(r, tailMs));
    // 让 worklet 交出缓冲区中剩余的采样
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 400);
      a.onFlushed = () => {
        clearTimeout(t);
        resolve();
      };
      try {
        a.node.port.postMessage('flush');
      } catch {
        resolve();
      }
    });
    a.gated = true;
    const frames = a.grabber ? await a.grabber.stop() : null;
    try {
      a.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    if (a.adOpen != null) this.setAd(materialId, false);
    await this.writeChunk(a);
    await a.writeChain;
    try {
      await a.ctx.close();
      await a.monCtx.close();
    } catch {
      /* ignore */
    }
    this.recs.delete(materialId);
    return { samples: a.writtenSamples, bytes: a.bytes, adIntervals: a.adIntervals, frames, writeError: a.writeError ? String(a.writeError.name || 'db') : null };
  }
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
