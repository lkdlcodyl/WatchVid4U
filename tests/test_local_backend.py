#!/usr/bin/env python3
"""本地后端协议测试（fake 引擎：验证 HTTP 协议、来源校验、说话人对齐逻辑；不代表真实识别质量）。"""
import io
import json
import struct
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "local-backend"))
import server as backend  # noqa: E402

PORT = 8766


def make_wav(seconds=12.0, sr=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack("<%dh" % int(seconds * sr), *([1000, -1000] * int(seconds * sr / 2))))
    return buf.getvalue()


def multipart(fields, wav):
    b = "----wv4u" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + wav + b"\r\n")
    parts.append(f"--{b}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={b}"


def post(fields, wav, origin="chrome-extension://abcdefghijklmnop"):
    body, ct = multipart(fields, wav)
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/audio/transcriptions", data=body, method="POST", headers={"Content-Type": ct, **({"Origin": origin} if origin else {})})
    try:
        r = urllib.request.urlopen(req, timeout=20)
        return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


class LocalBackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = subprocess.Popen([sys.executable, str(ROOT / "local-backend" / "server.py"), "--engine", "fake", "--fake-diarization", "--port", str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1)
                return
            except Exception:  # noqa: BLE001
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.p.terminate()
        cls.p.wait(5)

    def test_health(self):
        j = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health").read())
        self.assertEqual(j["engine"], "fake")
        self.assertTrue(j["diarization"])

    def test_verbose_json_with_speakers(self):
        code, j, h = post({"model": "auto", "language": "zh", "response_format": "verbose_json", "diarize": "true"}, make_wav(20))
        self.assertEqual(code, 200)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "chrome-extension://abcdefghijklmnop")
        self.assertEqual(j["speakers"]["count"], 2)
        self.assertTrue(j["speakers"]["reliable"])
        self.assertEqual({s["speaker"] for s in j["segments"]}, {"SPEAKER_00", "SPEAKER_01"})
        self.assertAlmostEqual(j["duration"], 20, places=2)

    def test_plain_json(self):
        code, j, _ = post({"model": "auto", "response_format": "json"}, make_wav(3))
        self.assertEqual(code, 200)
        self.assertIn("text", j)
        self.assertNotIn("segments", j)

    def test_rejects_web_origin(self):
        code, j, _ = post({"response_format": "json"}, make_wav(1), origin="https://evil.example")
        self.assertEqual(code, 403)

    def test_bad_audio(self):
        code, j, _ = post({"response_format": "json"}, b"not a wav")
        self.assertEqual(code, 400)

    def test_refuses_non_loopback(self):
        with self.assertRaises(SystemExit):
            backend.main(["--host", "0.0.0.0", "--engine", "fake"])

    def test_assign_speakers_uncertain_not_guessed(self):
        segs = [{"start": 0, "end": 4, "text": "a"}, {"start": 4, "end": 8, "text": "b"}, {"start": 8, "end": 12, "text": "c"}]
        turns = [(0, 4, "S0"), (4, 6, "S1"), (6, 8, "S0"), (8, 12, "S1"), (12, 30, "S0")]
        info = backend.assign_speakers(segs, turns, 30)
        self.assertEqual(segs[0]["speaker"], "S0")
        self.assertIsNone(segs[1]["speaker"])  # 两人各半，不猜
        self.assertEqual(segs[2]["speaker"], "S1")
        self.assertFalse(info["reliable"])  # 归属不足 80% → 不作为可靠分段稿


if __name__ == "__main__":
    unittest.main(verbosity=2)
