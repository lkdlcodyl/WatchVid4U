#!/usr/bin/env python3
"""WatchVid4U 可选本地转写服务。

- 仅监听本机回环地址；校验请求来源（默认只允许 chrome-extension:// 来源，可用 --allow-origin 限定为你的扩展 ID）。
- 提供 OpenAI 兼容的 POST /v1/audio/transcriptions（multipart），以及 GET /health。
- 识别引擎自动选择：mlx-whisper（Apple Silicon）> faster-whisper；只使用本机已有模型，运行时绝不下载。
- 说话人区分（可选）：pyannote.audio + 本地模型目录；失败或不可用时返回普通转写。
- 服务本身只依赖 Python 标准库；推理依赖按需安装（见 README）。
"""
from __future__ import annotations

import argparse
import email
import email.policy
import gc
import io
import json
import os
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 运行时禁止联网下载模型
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

VERSION = "1.0.0"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


# ---------------------------------------------------------------- 音频

def read_wav(data: bytes):
    """读取 16-bit PCM WAV，返回 (float 样本列表或 numpy 数组, 采样率, 时长秒)。"""
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("只支持 16-bit PCM WAV")
        ch = w.getnchannels()
        sr = w.getframerate()
        frames = w.readframes(w.getnframes())
    n = len(frames) // 2 // ch
    try:
        import numpy as np  # 推理引擎都依赖 numpy

        arr = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
        if ch > 1:
            arr = arr.reshape(-1, ch).mean(axis=1)
        return arr, sr, n / sr
    except ImportError:
        return None, sr, n / sr


# ---------------------------------------------------------------- 引擎

class FakeEngine:
    """测试用：不做真实识别，按时长返回固定文本（用于验证协议与集成，不代表识别质量）。"""

    name = "fake"

    def __init__(self, model):
        self.model = model or "fake"

    def transcribe(self, audio, sr, duration, language, prompt):
        segs = []
        t = 0.0
        i = 0
        while t < duration - 0.05:
            e = min(duration, t + 5.0)
            segs.append({"start": round(t, 2), "end": round(e, 2), "text": f"测试片段{i + 1}。", "avg_logprob": -0.2, "no_speech_prob": 0.01, "compression_ratio": 1.1})
            t = e
            i += 1
        return segs


class MlxEngine:
    name = "mlx-whisper"

    def __init__(self, model):
        import mlx_whisper  # noqa: F401

        self.mod = mlx_whisper
        self.model = model or find_mlx_model()
        if not self.model:
            raise RuntimeError("未找到本地 MLX Whisper 模型；请用 --model 指定模型目录（不会自动下载）")

    def transcribe(self, audio, sr, duration, language, prompt):
        r = self.mod.transcribe(audio, path_or_hf_repo=self.model, language=language or None, initial_prompt=prompt or None, temperature=0.0, condition_on_previous_text=False, verbose=None)
        return [seg_dict(s) for s in r.get("segments", [])]


class FasterEngine:
    name = "faster-whisper"

    def __init__(self, model):
        from faster_whisper import WhisperModel

        if not model:
            raise RuntimeError("请用 --model 指定 faster-whisper 模型目录或已缓存的模型名（不会自动下载）")
        self.model = model
        self.m = WhisperModel(model, device="auto", compute_type="auto", local_files_only=True)

    def transcribe(self, audio, sr, duration, language, prompt):
        segs, _info = self.m.transcribe(audio, language=language or None, initial_prompt=prompt or None, temperature=0.0, condition_on_previous_text=False, vad_filter=True)
        out = []
        for s in segs:
            out.append({"start": s.start, "end": s.end, "text": s.text, "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob, "compression_ratio": s.compression_ratio})
        return out


def seg_dict(s):
    return {k: s.get(k) for k in ("start", "end", "text", "avg_logprob", "no_speech_prob", "compression_ratio")}


def find_mlx_model():
    """复用 Hugging Face 缓存中已有的 mlx-community Whisper 模型（只读，不修改）。"""
    hub = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
    if not hub.exists():
        return None
    prefer = ["large-v3-turbo", "large-v3", "large-v2", "medium", "small", "base"]
    cands = [p for p in hub.glob("models--mlx-community--whisper-*") if (p / "snapshots").exists()]
    for key in prefer:
        for p in cands:
            if key in p.name:
                return "mlx-community/" + p.name.split("models--mlx-community--")[1]
    return ("mlx-community/" + cands[0].name.split("models--mlx-community--")[1]) if cands else None


def make_engine(kind, model):
    errors = []
    order = [kind] if kind != "auto" else ["mlx", "faster"]
    for k in order:
        try:
            if k == "fake":
                return FakeEngine(model)
            if k == "mlx":
                return MlxEngine(model)
            if k == "faster":
                return FasterEngine(model)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{k}: {e}")
    raise SystemExit("没有可用的识别引擎：\n  " + "\n  ".join(errors) + "\n请参阅 README 安装 mlx-whisper 或 faster-whisper 并准备本地模型。")


# ---------------------------------------------------------------- 说话人

class Diarizer:
    def __init__(self, path, fake=False):
        self.fake = fake
        self.pipeline = None
        self.error = None
        if fake:
            return
        if not path:
            self.error = "未配置说话人模型（--diarization-model）"
            return
        try:
            from pyannote.audio import Pipeline

            self.pipeline = Pipeline.from_pretrained(path)
        except Exception as e:  # noqa: BLE001
            self.error = f"说话人模型加载失败：{e}"

    @property
    def available(self):
        return self.fake or self.pipeline is not None

    def turns(self, audio, sr, duration):
        if self.fake:
            # 测试：前半段 A、后半段 B
            mid = duration / 2
            return [(0.0, mid, "SPEAKER_00"), (mid, duration, "SPEAKER_01")]
        import torch

        wav = torch.from_numpy(audio).unsqueeze(0)
        ann = self.pipeline({"waveform": wav, "sample_rate": sr})
        return [(t.start, t.end, spk) for t, _, spk in ann.itertracks(yield_label=True)]


def assign_speakers(segments, turns, duration):
    """按时间重叠为每段分配说话人；重叠不足 60% 或多人重叠时不归属（不猜）。"""
    total = {}
    for s, e, spk in turns:
        total[spk] = total.get(spk, 0.0) + (e - s)
    speech = sum(total.values()) or 1.0
    major = {k for k, v in total.items() if v >= max(5.0, 0.05 * speech)}
    for seg in segments:
        dur = max(0.01, seg["end"] - seg["start"])
        ov = {}
        for s, e, spk in turns:
            o = min(seg["end"], e) - max(seg["start"], s)
            if o > 0:
                ov[spk] = ov.get(spk, 0.0) + o
        best = max(ov.items(), key=lambda x: x[1]) if ov else None
        seg["speaker"] = best[0] if best and best[1] / dur >= 0.6 and best[0] in major else None
    assigned = sum(1 for s in segments if s["speaker"] is not None)
    reliable = len(major) >= 2 and assigned >= 0.8 * max(1, len(segments))
    return {"count": len(major), "reliable": reliable}


# ---------------------------------------------------------------- HTTP

class App:
    def __init__(self, args):
        self.args = args
        self.engine = make_engine(args.engine, args.model)
        self.diarizer = Diarizer(args.diarization_model, fake=args.engine == "fake" and args.fake_diarization)
        self.lock = threading.Lock()


def parse_multipart(ctype: str, body: bytes):
    msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body, policy=email.policy.HTTP)
    fields, files = {}, {}
    if not msg.is_multipart():
        raise ValueError("需要 multipart/form-data")
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        if part.get_filename() is not None:
            files[name] = payload
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


def make_handler(app: App):
    allow_origin = app.args.allow_origin

    class H(BaseHTTPRequestHandler):
        server_version = "WatchVid4U-Local/" + VERSION

        def log_message(self, fmt, *a):  # 不记录请求内容
            if app.args.verbose:
                sys.stderr.write("[local] " + (fmt % a) + "\n")

        def origin_ok(self):
            o = self.headers.get("Origin")
            if o is None:
                return True  # 命令行工具（curl）没有 Origin；浏览器网页一定会带 Origin
            if allow_origin:
                return o == allow_origin
            return o.startswith("chrome-extension://")

        def send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            o = self.headers.get("Origin")
            if o and self.origin_ok():
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if not self.origin_ok():
                return self.send_json(403, {"error": {"message": "origin not allowed"}})
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self):
            if not self.origin_ok():
                return self.send_json(403, {"error": {"message": "origin not allowed"}})
            if self.path.split("?")[0] == "/health":
                return self.send_json(200, {"ok": True, "version": VERSION, "engine": app.engine.name, "model": getattr(app.engine, "model", None), "diarization": app.diarizer.available, "note": None if app.diarizer.available else app.diarizer.error, "maxUploadMB": app.args.max_mb})
            self.send_json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            if not self.origin_ok():
                return self.send_json(403, {"error": {"message": "origin not allowed"}})
            if self.path.split("?")[0] != "/v1/audio/transcriptions":
                return self.send_json(404, {"error": {"message": "not found"}})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return self.send_json(400, {"error": {"message": "empty body"}})
            if length > app.args.max_mb * 1024 * 1024:
                return self.send_json(413, {"error": {"message": f"超过本地服务上限 {app.args.max_mb} MB"}})
            body = self.rfile.read(length)
            try:
                fields, files = parse_multipart(self.headers.get("Content-Type", ""), body)
            except Exception as e:  # noqa: BLE001
                return self.send_json(400, {"error": {"message": f"bad multipart: {e}"}})
            del body
            data = files.get("file")
            if not data:
                return self.send_json(400, {"error": {"message": "missing file"}})
            if not app.lock.acquire(timeout=1):
                return self.send_json(429, {"error": {"message": "本地服务正忙（一次只处理一个任务）"}})
            audio = None
            try:
                try:
                    audio, sr, duration = read_wav(data)
                except Exception as e:  # noqa: BLE001
                    return self.send_json(400, {"error": {"message": f"无法读取音频：{e}"}})
                del data
                t0 = time.time()
                segs = app.engine.transcribe(audio, sr, duration, fields.get("language", "zh"), fields.get("prompt", ""))
                speakers = None
                if fields.get("diarize") == "true":
                    if app.diarizer.available:
                        try:
                            speakers = assign_speakers(segs, app.diarizer.turns(audio, sr, duration), duration)
                        except Exception as e:  # noqa: BLE001
                            speakers = {"count": 0, "reliable": False, "error": f"说话人区分失败：{type(e).__name__}"}
                            for s in segs:
                                s.pop("speaker", None)
                    else:
                        speakers = {"count": 0, "reliable": False, "error": app.diarizer.error or "不可用"}
                text = "".join((s.get("text") or "").strip() for s in segs)
                fmt = fields.get("response_format", "json")
                if fmt == "text":
                    b = text.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Content-Length", str(len(b)))
                    o = self.headers.get("Origin")
                    if o:
                        self.send_header("Access-Control-Allow-Origin", o)
                    self.end_headers()
                    self.wfile.write(b)
                    return
                out = {"text": text}
                if fmt == "verbose_json":
                    out.update({"task": "transcribe", "language": fields.get("language", "zh"), "duration": duration, "segments": segs, "speakers": speakers, "engine": app.engine.name, "elapsed": round(time.time() - t0, 2)})
                return self.send_json(200, out)
            except Exception as e:  # noqa: BLE001
                if app.args.verbose:
                    traceback.print_exc()
                return self.send_json(500, {"error": {"message": f"本地识别失败：{type(e).__name__}"}})
            finally:
                audio = None
                gc.collect()
                app.lock.release()

    return H


def main(argv=None):
    p = argparse.ArgumentParser(description="WatchVid4U 本地转写服务（可选）")
    p.add_argument("--host", default="127.0.0.1", help="只允许回环地址")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--engine", default="auto", choices=["auto", "mlx", "faster", "fake"])
    p.add_argument("--model", default=os.environ.get("WV4U_MODEL"), help="模型目录或已缓存的模型名（不会下载）")
    p.add_argument("--diarization-model", default=os.environ.get("WV4U_DIARIZATION_MODEL"), help="pyannote 说话人流水线的本地目录/config.yaml")
    p.add_argument("--allow-origin", default=os.environ.get("WV4U_ALLOW_ORIGIN"), help="只允许该来源，如 chrome-extension://<扩展ID>")
    p.add_argument("--max-mb", type=int, default=2048)
    p.add_argument("--fake-diarization", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)
    if args.host not in LOOPBACK:
        raise SystemExit("出于安全考虑，只能监听本机回环地址（127.0.0.1 / localhost / ::1）")
    app = App(args)
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    print(f"WatchVid4U 本地服务已启动：http://{args.host}:{args.port}  引擎={app.engine.name}  说话人={'可用' if app.diarizer.available else '不可用'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
