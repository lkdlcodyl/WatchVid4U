#!/usr/bin/env python3
"""测试夹具服务器（仅用于本地验证，不随扩展发布）。

HTTPS（按 Host 路由，配合 Chrome --host-resolver-rules 把以下域名映射到本机）：
  www.bilibili.com / api.bilibili.com / aisubtitle.hdslb.com   模拟 B站页面与字幕接口
  www.youtube.com                                               模拟 YouTube 观看页（广告、续播倒计时）
  www.douyin.com                                                模拟抖音（循环播放）
HTTP（127.0.0.1）：
  /mock/stt*/v1/audio/transcriptions   模拟 OpenAI 兼容转写
  /mock/llm*/v1/chat/completions       模拟 Chat Completions（各类异常）
  /mock/log  /mock/reset               请求记录（只记录字段名、大小、音频时长/能量，用于断言）
  /tests/... /extension/...            静态文件（浏览器内单测）
"""
import email
import email.policy
import io
import json
import math
import os
import ssl
import struct
import subprocess
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
LOG = []
LOG_LOCK = threading.Lock()
STATE = {"stt_calls": 0}

# ---------------------------------------------------------------- B站模拟数据

SUB_LINES = [
    (0.5, 3.2, "大家好 欢迎收看本期节目"),
    (3.4, 7.0, "今天我们测试一下自动录音和转写功能"),
    (7.2, 11.5, "视频播放结束以后 网页应该保持暂停"),
    (11.6, 14.6, "不会自动播放下一条 谢谢观看"),
]
BILI = {
    "BV1SUB000001": {"aid": 1001, "duration": 15, "subs": [{"lan": "ai-zh", "lan_doc": "中文（自动生成）", "type": 1, "ai_type": 0, "ai_status": 2}]},
    "BV1MAN000001": {"aid": 1006, "duration": 15, "subs": [{"lan": "zh-CN", "lan_doc": "中文（中国）", "type": 0, "ai_type": 0, "ai_status": 0}]},
    "BV1NOSUB0001": {"aid": 1002, "duration": 15, "subs": []},
    "BV1MISMATCH1": {"aid": 1003, "duration": 15, "subs": [{"lan": "ai-zh", "lan_doc": "中文（自动生成）", "type": 1}], "wrong_cid": True},
    "BV1SHORT0001": {"aid": 1004, "duration": 600, "subs": [{"lan": "ai-zh", "lan_doc": "中文（自动生成）", "type": 1}]},
    "BV1LOGIN0001": {"aid": 1005, "duration": 15, "subs": [{"lan": "ai-zh", "lan_doc": "中文（自动生成）", "type": 1}], "need_login": True},
}


def cid_of(bvid, p=1):
    return BILI[bvid]["aid"] * 10 + p


# ---------------------------------------------------------------- 工具

def wav_stats(data):
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            sr = w.getframerate()
            n = w.getnframes()
            frames = w.readframes(n)
        cnt = len(frames) // 2
        samples = struct.unpack("<%dh" % cnt, frames) if cnt else ()
        rms = math.sqrt(sum(s * s for s in samples) / max(1, cnt)) / 32768.0 if cnt else 0.0
        head = samples[: int(sr * 0.5)]
        head_rms = math.sqrt(sum(s * s for s in head) / max(1, len(head))) / 32768.0 if head else 0.0
        return {"sr": sr, "duration": round(n / sr, 3), "rms": round(rms, 5), "head_rms": round(head_rms, 5)}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def parse_multipart(ctype, body):
    msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body, policy=email.policy.HTTP)
    fields, files = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if part.get_filename() is not None:
            files[name] = payload
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


def page(title, body_html, script=""):
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font-family:sans-serif;background:#111;color:#eee;margin:0;padding:20px}}video{{width:640px;height:360px;background:#000;display:block}}</style></head>
<body>{body_html}<script>{script}</script></body></html>"""


AGGRESSIVE = """
window.__events = [];
function log(e){ window.__events.push([Date.now(), e]); }
const v = document.querySelector('video');
['play','pause','ended','seeking','seeked'].forEach(t => v.addEventListener(t, () => log(t + '@' + v.currentTime.toFixed(2))));
// 网站在 ended 时切换下一条（我们的插件应在捕获阶段拦截）
const isAd = () => !!document.querySelector('.ad-showing');
v.addEventListener('ended', () => { if (isAd()) return; log('site-ended-handler'); setTimeout(() => goNext('ended-handler'), 800); });
// 激进脚本：接近结尾时计划一次延迟播放（不依赖 ended），模拟平台延迟续播
let scheduled = false;
v.addEventListener('timeupdate', () => {
  if (!scheduled && !isAd() && v.duration > 10 && v.currentTime > v.duration - 0.4) {
    scheduled = true;
    setTimeout(() => { log('delayed-play'); v.play().catch(()=>{}); }, 2500);
  }
});
"""


def bili_page(bvid, p):
    nxt = "BV1NEXT00001"
    script = AGGRESSIVE + f"""
function goNext(why){{ log('goNext:'+why); history.pushState(null,'','/video/{nxt}'); v.src='/media/next.webm'; v.play().catch(()=>{{}}); }}
"""
    body = f"""<div class="bpx-player-container"><div class="bpx-player-video-wrap"><video src="/media/speech.webm" preload="auto"></video></div></div><h1>模拟 B站视频 {bvid} P{p}</h1>"""
    return page(f"模拟视频{bvid}_哔哩哔哩_bilibili", body, script)


def yt_page(vid):
    ad = vid.startswith("ADTEST")
    script = AGGRESSIVE + f"""
const player = document.getElementById('movie_player');
const MAIN = '/media/speech.webm';
function goNext(why){{
  log('goNext:'+why);
  const ov = document.querySelector('.ytp-autonav-endscreen-countdown-overlay');
  ov.style.display='block';
  // 倒计时 2 秒后自动续播（除非点了取消）
  window.__autonav = setTimeout(() => {{ log('autonav-navigate'); history.pushState(null,'','/watch?v=NEXTVID'); v.src='/media/next.webm'; v.play().catch(()=>{{}}); }}, 2000);
}}
document.querySelector('.ytp-autonav-endscreen-upnext-cancel-button').addEventListener('click', () => {{ log('autonav-cancel'); clearTimeout(window.__autonav); document.querySelector('.ytp-autonav-endscreen-countdown-overlay').style.display='none'; }});
if ({'true' if ad else 'false'}) {{
  player.classList.add('ad-showing');
  v.src = '/media/ad.webm';
  v.addEventListener('ended', function onAdEnd(e) {{
    if (!player.classList.contains('ad-showing')) return;
    log('ad-ended'); player.classList.remove('ad-showing');
    v.src = MAIN; v.play().catch(()=>{{}});
  }});
  v.play().catch(()=>{{}});
}} else {{ v.src = MAIN; }}
"""
    body = """<div id="movie_player" class="html5-video-player"><video class="html5-main-video" preload="auto"></video>
<div class="ytp-autonav-endscreen-countdown-overlay" style="display:none">即将播放下一个 <button class="ytp-autonav-endscreen-upnext-cancel-button">取消</button></div></div>"""
    return page(f"模拟视频 {vid} - YouTube", body, script)


def dy_page(vid):
    hard = vid == "7000000000000000002"
    script = """
window.__events = [];
function log(e){ window.__events.push([Date.now(), e]); }
const v = document.querySelector('video');
v.loop = true;
['play','pause','ended','seeking'].forEach(t => v.addEventListener(t, () => log(t + '@' + v.currentTime.toFixed(2))));
v.addEventListener('ended', () => { log('site-replay'); v.currentTime = 0; v.play().catch(()=>{}); });
""" + ("setInterval(() => { v.loop = true; }, 300);" if hard else "")
    body = '<div class="xg-video-container"><video src="/media/speech.webm" preload="auto"></video></div>'
    return page(f"模拟抖音 {vid} - 抖音", body, script)


# ---------------------------------------------------------------- 处理器

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def record(self, kind, **kw):
        with LOG_LOCK:
            LOG.append({"t": time.time(), "kind": kind, "host": self.host(), "path": self.path, **kw})

    def host(self):
        return (self.headers.get("Host") or "").split(":")[0]

    def do_OPTIONS(self):
        o = self.headers.get("Origin", "*")
        self.send(204, b"", headers={"Access-Control-Allow-Origin": o, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type,Authorization"})

    def static(self, rel, root=ROOT):
        p = (root / rel).resolve()
        if not str(p).startswith(str(root)) or not p.is_file():
            return self.send(404, {"error": "not found"})
        ct = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".webm": "video/webm", ".wav": "audio/wav", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml"}.get(p.suffix, "application/octet-stream")
        data = p.read_bytes()
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes=") and p.suffix in (".webm", ".wav"):
            a, _, b = rng[6:].partition("-")
            a = int(a or 0)
            b = int(b) if b else len(data) - 1
            chunk = data[a : b + 1]
            self.send_response(206)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
            return
        self.send(200, data, ct, {"Accept-Ranges": "bytes"} if p.suffix in (".webm", ".wav") else None)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        host = self.host()
        if u.path.startswith("/media/"):
            return self.static(u.path[7:], FIX / "media")
        if host == "api.bilibili.com":
            return self.bili_api(u, q)
        if host.endswith("hdslb.com"):
            return self.bili_sub(u)
        if host == "www.bilibili.com":
            parts = u.path.split("/")
            if len(parts) >= 3 and parts[1] == "video":
                return self.send(200, bili_page(parts[2], int(q.get("p", ["1"])[0])), "text/html; charset=utf-8")
        if host == "www.youtube.com" and u.path == "/watch":
            return self.send(200, yt_page(q.get("v", [""])[0]), "text/html; charset=utf-8")
        if host == "www.douyin.com" and u.path.startswith("/video/"):
            return self.send(200, dy_page(u.path.split("/")[2]), "text/html; charset=utf-8")
        if u.path == "/mock/log":
            with LOG_LOCK:
                return self.send(200, LOG)
        if u.path == "/mock/reset":
            with LOG_LOCK:
                LOG.clear()
            STATE["stt_calls"] = 0
            return self.send(200, {"ok": True})
        if u.path.startswith("/tests/") or u.path.startswith("/extension/"):
            return self.static(u.path[1:])
        if u.path == "/health":
            return self.send(200, {"ok": True})
        return self.send(404, {"error": "not found"})

    # --- B站接口模拟
    def bili_api(self, u, q):
        origin = self.headers.get("Origin")
        cors = {"Access-Control-Allow-Origin": origin or "*", "Access-Control-Allow-Credentials": "true"}
        has_cookie = "SESSDATA=" in (self.headers.get("Cookie") or "")
        self.record("bili-api", cookie=has_cookie, origin=origin, referer_present=bool(self.headers.get("Referer")))
        bvid = (q.get("bvid") or [""])[0]
        aid = (q.get("aid") or [""])[0]
        if not bvid and aid:
            bvid = next((k for k, v in BILI.items() if str(v["aid"]) == aid), "")
        info = BILI.get(bvid)
        if not info:
            return self.send(200, {"code": -404, "message": "啥都木有"}, headers=cors)
        if u.path == "/x/web-interface/view":
            pages = [{"cid": cid_of(bvid, 1), "page": 1, "part": "第一集", "duration": info["duration"]}, {"cid": cid_of(bvid, 2), "page": 2, "part": "第二集", "duration": info["duration"]}]
            return self.send(200, {"code": 0, "data": {"bvid": bvid, "aid": info["aid"], "cid": pages[0]["cid"], "title": f"模拟视频{bvid}", "duration": info["duration"], "pages": pages}}, headers=cors)
        if u.path in ("/x/player/v2", "/x/player/wbi/v2"):
            cid = int((q.get("cid") or ["0"])[0])
            subs = []
            if not (info.get("need_login") and not has_cookie):
                for i, s in enumerate(info["subs"]):
                    subs.append({"id": 900 + i, "id_str": str(900 + i), "lan": s["lan"], "lan_doc": s["lan_doc"], "type": s.get("type"), "ai_type": s.get("ai_type", 0), "ai_status": s.get("ai_status", 0), "subtitle_url": f"//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/{bvid}_{cid}.json?auth_key=test"})
            data = {"aid": info["aid"], "bvid": bvid, "cid": 99999 if info.get("wrong_cid") else cid, "subtitle": {"subtitles": subs}, "need_login_subtitle": bool(info.get("need_login") and not has_cookie)}
            return self.send(200, {"code": 0, "data": data}, headers=cors)
        return self.send(200, {"code": -400}, headers=cors)

    def bili_sub(self, u):
        name = u.path.rsplit("/", 1)[-1].split(".")[0]
        bvid = name.split("_")[0]
        self.record("bili-sub", bvid=bvid)
        lines = SUB_LINES if bvid != "BV1SHORT0001" else SUB_LINES[:2]
        body = {"font_size": 0.4, "body": [{"from": a, "to": b, "location": 2, "content": c} for a, b, c in lines]}
        return self.send(200, body, headers={"Access-Control-Allow-Origin": "*"})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if u.path.startswith("/mock/stt") and u.path.endswith("/audio/transcriptions"):
            return self.mock_stt(u.path.split("/")[2], body)
        if u.path.startswith("/mock/llm") and u.path.endswith("/chat/completions"):
            return self.mock_llm(u.path.split("/")[2], body)
        return self.send(404, {"error": "not found"})

    def mock_stt(self, variant, body):
        STATE["stt_calls"] += 1
        call = STATE["stt_calls"]
        try:
            fields, files = parse_multipart(self.headers.get("Content-Type", ""), body)
        except Exception as e:  # noqa: BLE001
            return self.send(400, {"error": {"message": str(e)}})
        stats = wav_stats(files.get("file", b""))
        self.record("stt", variant=variant, call=call, fields=sorted(fields.keys()), prompt=fields.get("prompt", ""), model=fields.get("model"), fmt=fields.get("response_format"), auth=bool(self.headers.get("Authorization")), bytes=len(files.get("file", b"")), **stats)
        if variant == "stt-413":
            return self.send(413, {"error": {"message": "Request Entity Too Large"}})
        if variant == "stt-403-detail":
            return self.send(403, {"detail": {"code": "ORIGIN_DENIED", "message": "origin denied"}})
        if variant == "stt-html":
            return self.send(200, "<!doctype html><html><body>gateway</body></html>", "text/html")
        if variant == "stt-fail3" and call == 3:
            return self.send(500, {"error": {"message": "internal"}})
        if variant == "stt-slow":
            time.sleep(6)
        dur = stats.get("duration", 0)
        k = call
        segs = []
        t = 0.0
        i = 0
        while t < dur - 0.01:
            e = min(dur, t + 4.0)
            segs.append({"id": i, "start": round(t, 2), "end": round(e, 2), "text": f"第{k}片第{i + 1}句。", "avg_logprob": -0.2, "no_speech_prob": 0.02, "compression_ratio": 1.2})
            t = e
            i += 1
        if variant == "stt-halluc" and segs:
            segs.append({"id": i, "start": dur, "end": dur + 2, "text": "请不吝点赞订阅转发打赏支持明镜与点点栏目", "avg_logprob": -1.4, "no_speech_prob": 0.9, "compression_ratio": 1.3})
        text = "".join(s["text"] for s in segs)
        if fields.get("response_format") == "json":
            return self.send(200, {"text": text})
        return self.send(200, {"text": text, "segments": segs, "duration": dur, "x_rms": stats.get("rms"), "x_head_rms": stats.get("head_rms")})

    def mock_llm(self, variant, body):
        try:
            j = json.loads(body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            j = {}
        msgs = j.get("messages", [])
        self.record("llm", variant=variant, stream=j.get("stream"), model=j.get("model"), roles=[m.get("role") for m in msgs], user_len=sum(len(m.get("content", "")) for m in msgs if m.get("role") == "user"), user=msgs[-1]["content"][:4000] if msgs else "", system_has_mode=("模式：" in (msgs[0].get("content", "") if msgs else "")), auth=bool(self.headers.get("Authorization")))
        if variant == "llm-html":
            return self.send(200, "<html><body>login</body></html>", "text/html")
        if variant == "llm-stream":
            return self.send(200, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', "text/event-stream")
        if variant == "llm-empty":
            return self.send(200, b"", "application/json")
        if variant == "llm-badjson":
            return self.send(200, "{not json", "application/json")
        if variant == "llm-length":
            return self.send(200, {"choices": [{"message": {"content": "# 半截"}, "finish_reason": "length"}]})
        if variant == "llm-nocontent":
            return self.send(200, {"choices": [{"message": {"content": ""}, "finish_reason": "stop"}]})
        if variant == "llm-500":
            return self.send(500, {"error": {"message": "server overloaded"}})
        if variant == "llm-401":
            return self.send(401, {"error": {"message": "invalid api key sk-abcdefghijklmnop"}})
        content = "<think>内部推理</think>\n```markdown\n# 测试笔记\n\n## 要点\n- 讲者介绍了**自动录音**与转写。\n- <script>alert(1)</script> 应作为文本显示\n\n[链接](javascript:alert(1))\n```"
        return self.send(200, {"id": "x", "model": j.get("model"), "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}], "usage": {"total_tokens": 10}})


def make_cert(d):
    crt, key = d / "cert.pem", d / "key.pem"
    if not crt.exists():
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(crt), "-days", "2", "-subj", "/CN=wv4u-test"], check=True, capture_output=True)
    return crt, key


def serve(http_port, https_port, certdir):
    certdir = Path(certdir)
    certdir.mkdir(parents=True, exist_ok=True)
    crt, key = make_cert(certdir)
    h1 = ThreadingHTTPServer(("127.0.0.1", http_port), Handler)
    h2 = ThreadingHTTPServer(("127.0.0.1", https_port), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    h2.socket = ctx.wrap_socket(h2.socket, server_side=True)
    for s in (h1, h2):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    return h1, h2


if __name__ == "__main__":
    hp = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    sp = int(sys.argv[2]) if len(sys.argv) > 2 else 8791
    serve(hp, sp, os.environ.get("WV4U_CERTDIR", "/tmp/wv4u-cert"))
    print(f"http://127.0.0.1:{hp}  https://127.0.0.1:{sp}", flush=True)
    while True:
        time.sleep(3600)
