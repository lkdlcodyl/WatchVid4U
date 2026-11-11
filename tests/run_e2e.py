#!/usr/bin/env python3
"""扩展端到端测试（真实 Chrome + 解包加载的扩展 + 本地模拟站点/服务）。

真实的：扩展加载、Service Worker 状态机、内容脚本对 <video> 的控制与结束判定、播完暂停保护、
       offscreen AudioWorklet 录音链路与 IndexedDB 落盘、WAV 切片、对模拟服务的真实 HTTP 请求、界面渲染。
替身的：标签页音频来源（tabCapture 需要用户点击工具栏图标，无法自动化 → 用同一份测试音频生成的媒体流替代）、
       B站/YouTube/抖音页面与接口（本地夹具 + 域名映射）、STT/LLM 服务（本地模拟）。
"""
import json
import shutil
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from cdp import Chrome, CDPError  # noqa: E402
from server import serve  # noqa: E402

HTTP, HTTPS = 8790, 8791
OUT = HERE / "out"
RESULTS = []


def build_test_extension():
    d = Path(tempfile.mkdtemp(prefix="wv4u-ext-")) / "ext"
    shutil.copytree(ROOT / "extension", d)
    shutil.copytree(HERE / "e2e" / "ext-overlay", d, dirs_exist_ok=True)
    (d / "test-media").mkdir()
    shutil.copy(HERE / "fixtures" / "media" / "speech16k.wav", d / "test-media" / "speech16k.wav")
    m = json.loads((d / "manifest.json").read_text())
    m["background"]["service_worker"] = "src/background/sw-test.js"
    m["host_permissions"] = ["http://127.0.0.1/*"]
    (d / "manifest.json").write_text(json.dumps(m, ensure_ascii=False, indent=2))
    off = d / "src" / "offscreen" / "offscreen.html"
    off.write_text(off.read_text().replace('<script type="module" src="offscreen.js"></script>', '<script type="module" src="test-shim.js"></script>\n<script type="module" src="offscreen.js"></script>'))
    return d


def mock(path):
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{HTTP}{path}").read())


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)
    return cond


class E2E:
    def __init__(self):
        rules = ",".join(f"MAP {h} 127.0.0.1:{HTTPS}" for h in ["www.bilibili.com", "api.bilibili.com", "aisubtitle.hdslb.com", "www.youtube.com", "www.douyin.com"])
        self.c = Chrome(extra_args=[f"--host-resolver-rules={rules}", "--ignore-certificate-errors"])
        self.ext_dir = build_test_extension()
        self.ext_id = self.c.send("Extensions.loadUnpacked", {"path": str(self.ext_dir)})["id"]
        self.base = f"chrome-extension://{self.ext_id}"
        _, self.h = self.c.new_tab(f"{self.base}/test-harness.html")
        self.c.wait_for(self.h, "window.__ready === true", timeout=20)
        # 检查项按中文界面编写：固定界面语言为中文（“跟随浏览器”在英文环境下会切到英文）
        self.T("return T.patchSettings({ 'ui.lang': 'zh' })")

    def T(self, expr, timeout=60):
        return self.c.eval(self.h, f"(async () => {{ {expr} }})()", timeout=timeout)

    def open_page(self, url):
        tid, sid = self.c.new_tab(url)
        self.c.wait_for(sid, "!!document.querySelector('video') && document.querySelector('video').readyState >= 1", timeout=20)
        time.sleep(0.8)  # 等内容脚本就绪
        tab = self.T("return T.tabId()")
        return tid, sid, tab

    def close(self, tid):
        try:
            self.c.send("Target.closeTarget", {"targetId": tid})
        except CDPError:
            pass

    def wait_task(self, phases, timeout=60):
        end = time.time() + timeout
        t = None
        while time.time() < end:
            t = self.T("return T.task()")
            if t and t.get("phase") in phases:
                return t
            time.sleep(0.3)
        raise CDPError(f"task did not reach {phases}; last={t and t.get('phase')} {t and t.get('phaseText')}")

    def video(self, sid):
        return self.c.eval(sid, "(() => { const v = document.querySelector('video'); return { paused: v.paused, t: +v.currentTime.toFixed(2), d: +(v.duration||0).toFixed(2), ended: v.ended, loop: v.loop, url: location.href, events: (window.__events||[]).map(e => e[1]) }; })()")


def scenario(fn):
    def run(e):
        print(f"\n== {fn.__doc__}", flush=True)
        try:
            fn(e)
        except Exception as ex:  # noqa: BLE001
            check(f"{fn.__doc__}：无异常", False, f"{type(ex).__name__}: {ex}")
            traceback.print_exc()
        finally:
            try:
                e.T("return T.sw('cancel')")
                e.T("return T.sw('dismiss-task')")
            except Exception:  # noqa: BLE001
                pass
    return run


@scenario
def s_bili_subtitle(e):
    """B站有字幕：一键直接得到逐字稿，不调用 STT、不需播放"""
    mock("/mock/reset")
    e.T("return T.configure()")
    tid, sid, tab = e.open_page("https://www.bilibili.com/video/BV1SUB000001")
    r = e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    check("开始请求被接受", r.get("ok"), r)
    t = e.wait_task(["done", "failed"], 20)
    check("任务完成", t["phase"] == "done", t.get("phaseText"))
    check("字幕状态为成功", t["subtitle"]["state"] == "ok" and t["subtitle"]["kind"] == "auto", t["subtitle"])
    mats = e.T("return T.materials()")
    m = next((x for x in mats if x["id"] == t["materialId"]), None)
    check("材料来源为字幕且含正文", m and m["source"] == "subtitle" and "欢迎收看本期节目" in m["transcript"]["effective"], m and m["transcript"])
    check("字幕类型如实标注为自动生成", m and m["subtitle"]["kindLabel"] == "自动生成字幕")
    check("未产生空音频", m and m["audio"] is None)
    log = mock("/mock/log")
    check("未调用 STT", not any(x["kind"] == "stt" for x in log))
    check("字幕请求未携带 Cookie（未开启登录态）", all(not x.get("cookie") for x in log if x["kind"] == "bili-api"))
    v = e.video(sid)
    check("字幕路径不触碰视频播放", v["paused"] and v["t"] < 0.5, v)
    e.close(tid)


@scenario
def s_bili_fallback(e):
    """B站无字幕：同一任务自动转录音（从头），播完暂停并阻止下一条，自动转写"""
    mock("/mock/reset")
    e.T("return T.configure()")
    tid, sid, tab = e.open_page("https://www.bilibili.com/video/BV1NOSUB0001")
    e.c.eval(sid, "(() => { const v = document.querySelector('video'); v.currentTime = 6; return true; })()")
    time.sleep(0.5)
    r = e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'beginning' }})")
    check("开始请求被接受", r.get("ok"), r)
    t = e.wait_task(["recording", "failed"], 25)
    check("字幕失败后自动进入录音（无需第二次点击）", t["phase"] == "recording" and t["subtitle"]["state"] == "failed", t.get("subtitle"))
    check("失败原因可读", "没有可用字幕" in (t["subtitle"].get("reason") or ""), t["subtitle"])
    time.sleep(1.0)
    v = e.video(sid)
    check("从头开始播放（不是从当前进度）", v["t"] < 4 and not v["paused"], v)
    t = e.wait_task(["transcribing", "done", "failed", "interrupted"], 40)
    v = e.video(sid)
    check("播到结尾后网页已暂停", v["paused"], v)
    check("录音因正常播完而结束（非中断）", t["audio"]["state"] == "saved" and t["audio"].get("endReason") == "ended", t["audio"])
    time.sleep(4.5)  # 等待网站的“下一条”与延迟播放脚本
    v = e.video(sid)
    check("网站 ended 处理器未收到事件（未切到下一条）", "site-ended-handler" not in v["events"] and "BV1NEXT" not in v["url"], v["events"][-6:])
    check("延迟续播被拦截，网页保持暂停", v["paused"] and ("delayed-play" not in v["events"] or v["paused"]), v["events"][-6:])
    t = e.wait_task(["done", "failed"], 40)
    check("自动转写完成", t["phase"] == "done" and t["stt"]["state"] == "done", t.get("phaseText"))
    check("播放保护状态被报告", t["playback"]["state"] in ("guarded",), t["playback"])
    info = e.T(f"return T.audioInfo({json.dumps(t['materialId'])})")
    check("录音时长与正文一致（约 15 s，未混入下一条）", 14.3 <= info["seconds"] <= 16.6, info)
    check("片头未丢失（开头 0.5 s 提示音有能量）", info["headRms"] > 0.02, info)
    log = [x for x in mock("/mock/log") if x["kind"] == "stt"]
    check("STT 只调用一次且收到非静音音频", len(log) == 1 and log[0]["rms"] > 0.01, log)
    check("STT 请求只含音频与必要参数", log and log[0]["fields"] == ["language", "model", "prompt", "response_format", "temperature"], log and log[0]["fields"])
    m = e.T(f"return T.material({json.dumps(t['materialId'])})")
    check("逐字稿已保存", m["transcript"] and "第1片" in m["transcript"]["effective"])
    check("材料记录字幕未采用原因", m.get("subtitleAttempt") and "没有可用字幕" in m["subtitleAttempt"]["reason"])
    # 用户主动继续播放可以解除保护
    e.c.eval(sid, "(() => { document.querySelector('video').currentTime = 2; return true; })()")
    e.c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 100, "y": 100, "button": "left", "clickCount": 1}, session=sid)
    e.c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": 100, "y": 100, "button": "left", "clickCount": 1}, session=sid)
    e.c.eval(sid, "document.querySelector('video').play().then(() => true)")
    time.sleep(1.5)
    v = e.video(sid)
    check("用户主动播放后正常播放（保护解除）", not v["paused"], v)
    e.close(tid)


@scenario
def s_bili_mismatch(e):
    """B站接口返回其他分P：拒绝串字幕并自动转录音"""
    mock("/mock/reset")
    e.T("return T.configure()")
    tid, sid, tab = e.open_page("https://www.bilibili.com/video/BV1MISMATCH1")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    t = e.wait_task(["recording", "failed", "done"], 20)
    check("识别不一致并转录音", t["phase"] == "recording" and t["subtitle"].get("code") == "sub_mismatch", t.get("subtitle"))
    e.T("return T.sw('cancel')")
    t = e.wait_task(["cancelled"], 10)
    m = e.T(f"return T.material({json.dumps(t['materialId'])})")
    check("取消后已录部分标为不完整、未上传", m["status"] == "incomplete" and not any(x["kind"] == "stt" for x in mock("/mock/log")), m["status"])
    e.close(tid)


@scenario
def s_bili_incomplete_login(e):
    """B站字幕不完整 / 需要登录：不假报成功，自动录音；允许登录态后可取得字幕"""
    mock("/mock/reset")
    e.T("return T.configure()")
    tid, sid, tab = e.open_page("https://www.bilibili.com/video/BV1SHORT0001")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    t = e.wait_task(["recording", "failed", "done"], 20)
    check("字幕不完整被识别", t["subtitle"].get("code") == "sub_incomplete", t["subtitle"])
    e.T("return T.sw('cancel')")
    e.close(tid)
    tid, sid, tab = e.open_page("https://www.bilibili.com/video/BV1LOGIN0001")
    e.c.eval(sid, "document.cookie = 'SESSDATA=fake-session; domain=.bilibili.com; path=/; secure; samesite=lax'; true")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    t = e.wait_task(["recording", "failed", "done"], 20)
    check("未开启登录态时：需要登录 → 自动录音", t["phase"] == "recording" and t["subtitle"].get("code") == "sub_need_login", t["subtitle"])
    e.T("return T.sw('cancel')")
    e.T("return T.sw('dismiss-task')")
    e.T("return T.patchSettings({'subtitle.useLogin': true})")
    mock("/mock/reset")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    t = e.wait_task(["done", "failed", "recording"], 20)
    check("开启登录态后取得字幕", t["phase"] == "done" and t["subtitle"]["state"] == "ok", t.get("subtitle"))
    log = [x for x in mock("/mock/log") if x["kind"] == "bili-api"]
    check("登录态请求由 B站页面同源发起（携带 Cookie，来源为 www.bilibili.com）", any(x["cookie"] for x in log) and all(x["origin"] == "https://www.bilibili.com" for x in log), log[:2])
    e.T("return T.patchSettings({'subtitle.useLogin': false})")
    e.close(tid)


@scenario
def s_youtube_ad(e):
    """YouTube 前贴广告 + 从头：等待正文起点，播完取消续播倒计时并保持暂停"""
    mock("/mock/reset")
    e.T("return T.configure()")
    tid, sid, tab = e.open_page("https://www.youtube.com/watch?v=ADTEST1")
    r = e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'beginning' }})")
    check("开始请求被接受", r.get("ok"), r)
    t = e.wait_task(["waiting_ad", "recording", "failed"], 10)
    check("广告期间进入“等待广告结束”", t["phase"] == "waiting_ad", t["phase"])
    t = e.wait_task(["recording", "failed"], 15)
    v = e.video(sid)
    check("广告结束后从正文开头录音", t["phase"] == "recording" and "speech" in e.c.eval(sid, "document.querySelector('video').currentSrc") and v["t"] < 3, v)
    t = e.wait_task(["transcribing", "done", "failed", "interrupted"], 40)
    check("正文结束后完成录音", t["audio"]["state"] == "saved", t["audio"])
    time.sleep(4)
    v = e.video(sid)
    check("未自动续播到下一条（URL 未变、保持暂停）", "NEXTVID" not in v["url"] and v["paused"], v)
    t = e.wait_task(["done", "failed"], 30)
    info = e.T(f"return T.audioInfo({json.dumps(t['materialId'])})")
    check("录音不含广告前缀（时长≈正文）", 14.3 <= info["seconds"] <= 16.6, info)
    e.close(tid)


@scenario
def s_douyin_loop(e):
    """抖音循环：播完不从头重播（含页面反复把 loop 设回 true 的情况）"""
    for vid in ["7000000000000000001", "7000000000000000002"]:
        mock("/mock/reset")
        e.T("return T.configure({patch: {'record.autoTranscribe': false}})")
        tid, sid, tab = e.open_page(f"https://www.douyin.com/video/{vid}")
        e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'beginning' }})")
        t = e.wait_task(["done", "failed", "interrupted"], 40)
        time.sleep(3)
        v = e.video(sid)
        check(f"[{vid[-1]}] 完成且网页保持暂停（不循环）", t["phase"] == "done" and v["paused"] and v["t"] > v["d"] - 1.5, {"phase": t["phase"], **{k: v[k] for k in ("paused", "t", "d")}})
        check(f"[{vid[-1]}] 自动转写关闭时只保存音频", t["audio"]["state"] == "saved" and not any(x["kind"] == "stt" for x in mock("/mock/log")))
        e.T("return T.sw('dismiss-task')")
        e.close(tid)
    e.T("return T.configure()")


@scenario
def s_duplicate_and_switch(e):
    """重复点击只启动一个任务；换视频时中断并保留不完整录音"""
    mock("/mock/reset")
    e.T("return T.configure()")
    before = len(e.T("return T.materials()"))
    tid, sid, tab = e.open_page("https://www.youtube.com/watch?v=NOAD1")
    rs = e.T(f"return Promise.all([T.sw('start', {{ tabId: {tab}, mode: 'current' }}), T.sw('start', {{ tabId: {tab}, mode: 'current' }}), T.sw('start', {{ tabId: {tab}, mode: 'beginning' }})])")
    check("并发三次点击只有一个新任务", sum(1 for r in rs if r.get("ok") and not r.get("already")) == 1, rs)
    e.wait_task(["recording"], 15)
    time.sleep(3)
    e.c.eval(sid, "history.pushState(null, '', '/watch?v=OTHERVID'); true")
    t = e.wait_task(["interrupted", "failed", "done"], 10)
    check("换视频后任务中断", t["phase"] == "interrupted", t.get("phaseText"))
    m = e.T(f"return T.material({json.dumps(t['materialId'])})")
    check("已录部分保留并标为不完整", m["status"] == "incomplete" and m["audio"]["samples"] > 16000, m["audio"])
    check("不完整录音未自动上传", not any(x["kind"] == "stt" for x in mock("/mock/log")))
    after = len(e.T("return T.materials()"))
    check("只新增一条材料", after - before == 1, after - before)
    e.close(tid)


@scenario
def s_manual_stop(e):
    """手动停止并保存：区分于正常播完，按设置自动转写"""
    mock("/mock/reset")
    e.T("return T.configure()")
    tid, sid, tab = e.open_page("https://www.youtube.com/watch?v=NOAD2")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    e.wait_task(["recording"], 15)
    time.sleep(4)
    e.T("return T.sw('stop')")
    t = e.wait_task(["done", "failed"], 30)
    v = e.video(sid)
    check("手动停止后网页暂停", v["paused"], v)
    check("结束方式为手动", t["audio"].get("endReason") == "manual", t["audio"])
    check("手动停止后自动转写", t["stt"]["state"] == "done", t["stt"])
    e.close(tid)


@scenario
def s_multi_tab(e):
    """多个标签页同时录制：各自独立录音与结束，超过上限时拒绝，转写依次排队"""
    mock("/mock/reset")
    e.T("return T.configure({ sttVariant: 'stt-slow', patch: { 'record.maxConcurrent': 2 } })")
    tid1, sid1, tab1 = e.open_page("https://www.youtube.com/watch?v=NOADM1")
    tid2, sid2, tab2 = e.open_page("https://www.youtube.com/watch?v=NOADM2")
    r1 = e.T(f"return T.sw('start', {{ tabId: {tab1}, mode: 'current' }})")
    r2 = e.T(f"return T.sw('start', {{ tabId: {tab2}, mode: 'current' }})")
    check("两个标签页都能开始", r1.get("ok") and r2.get("ok") and not r2.get("already"), (r1.get("error"), r2.get("error")))

    def wait_tab(tab, phases, timeout=30):
        end = time.time() + timeout
        t = None
        while time.time() < end:
            t = e.T(f"return T.taskForTab({tab})")
            if t and t.get("phase") in phases:
                return t
            time.sleep(0.3)
        raise CDPError(f"tab {tab} did not reach {phases}; last={t and t.get('phase')} {t and t.get('phaseText')}")

    t1 = wait_tab(tab1, ["recording"], 15)
    t2 = wait_tab(tab2, ["recording"], 15)
    check("两个任务同时处于录音中", t1["phase"] == "recording" and t2["phase"] == "recording" and t1["materialId"] != t2["materialId"])
    st = e.T("return T.sw('get-state')")
    check("后台记录两个进行中的任务", st.get("capturing") == 2 and len([x for x in st.get("tasks", []) if x["phase"] == "recording"]) == 2, st.get("capturing"))
    tid3, sid3, tab3 = e.open_page("https://www.youtube.com/watch?v=NOADM3")
    r3 = e.T(f"return T.sw('start', {{ tabId: {tab3}, mode: 'current' }})")
    check("超过同时录制上限时拒绝并说明原因", not r3.get("ok") and (r3.get("error") or {}).get("code") == "task_limit", r3)
    e.close(tid3)
    time.sleep(3)
    e.T(f"return T.sw('stop', {{ taskId: {json.dumps(t1['id'])} }})")
    time.sleep(0.5)
    a2 = e.T(f"return T.taskForTab({tab2})")
    check("停止一个任务不影响另一个继续录音", a2["phase"] == "recording", a2["phase"])
    e.T(f"return T.sw('stop', {{ taskId: {json.dumps(t2['id'])} }})")
    queued = False
    end = time.time() + 10
    while time.time() < end and not queued:
        for tab in (tab1, tab2):
            x = e.T(f"return T.taskForTab({tab})")
            if x and (x.get("stt") or {}).get("state") == "queued":
                queued = True
        time.sleep(0.3)
    check("第二个转写进入排队", queued)
    d1 = wait_tab(tab1, ["done", "failed"], 40)
    d2 = wait_tab(tab2, ["done", "failed"], 40)
    check("两个任务都完成转写", d1["phase"] == "done" and d2["phase"] == "done" and d1["stt"]["state"] == "done" and d2["stt"]["state"] == "done", (d1.get("phaseText"), d2.get("phaseText")))
    calls = sorted(x["t"] for x in mock("/mock/log") if x["kind"] == "stt")
    check("转写依次进行，没有同时发送", len(calls) == 2 and calls[1] - calls[0] >= 5.5, calls)
    for m in (d1, d2):
        info = e.T(f"return T.audioInfo({json.dumps(m['materialId'])})")
        check("每个标签页各自保存了录音", info["seconds"] > 2, info)
    v1, v2 = e.video(sid1), e.video(sid2)
    check("停止后两个网页都已暂停", v1["paused"] and v2["paused"], (v1, v2))
    e.close(tid1)
    e.close(tid2)


@scenario
def s_frames(e):
    """录制时截取画面：保存在本机、跳过重复，笔记附带画面（需单独确认），未确认时不发送"""
    mock("/mock/reset")
    e.T("return T.configure({ patch: { 'note.auto': true, 'record.autoTranscribe': true } })")
    e.T("return T.enableFrames(5, 20)")
    tid, sid, tab = e.open_page("https://www.youtube.com/watch?v=NOADF1")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    t = e.wait_task(["done", "failed", "interrupted"], 60)
    check("截帧任务完成（录音、转写、笔记）", t["phase"] == "done" and t["note"]["state"] == "done", t.get("phaseText"))
    m = e.T(f"return T.material({json.dumps(t['materialId'])})")
    fr = e.T(f"return T.frames({json.dumps(t['materialId'])})")
    check("录制时按间隔保存了画面", (m.get("frames") or {}).get("count", 0) >= 2 and len(fr) == m["frames"]["count"], (m.get("frames"), len(fr)))
    check("画面为缩小后的 JPEG，带录音时间", all(f["type"] == "image/jpeg" and f["w"] <= 768 and f["bytes"] > 0 for f in fr) and all(fr[i]["t"] < fr[i + 1]["t"] for i in range(len(fr) - 1)), fr[:3])
    llm = [x for x in mock("/mock/log") if x["kind"] == "llm"]
    check("笔记请求附带了画面（JPEG，数量与保存一致）", len(llm) == 1 and llm[0]["images"] == len(fr) and llm[0]["images_jpeg"] and llm[0]["frames_rule"], llm and {k: llm[0][k] for k in ("images", "images_jpeg", "frames_rule")})
    check("附带画面时逐字稿带时间标记", llm and "[0:00]" in llm[0]["user"], llm and llm[0]["user"][:80])
    note = (m.get("notes") or {}).get("concise") or {}
    check("笔记记录了参考的画面数", note.get("frames") == len(fr), note.get("frames"))
    # 未确认（或已撤销）“附带画面”时：只发送逐字稿
    mock("/mock/reset")
    e.T("return T.enableFrames(5, 20, false)")
    e.T(f"return T.sw('material-note', {{ materialId: {json.dumps(t['materialId'])}, mode: 'detailed' }})")
    end = time.time() + 20
    llm = []
    while time.time() < end and not llm:
        llm = [x for x in mock("/mock/log") if x["kind"] == "llm"]
        time.sleep(0.3)
    check("未确认附带画面时不发送任何画面", llm and llm[0]["images"] == 0 and not llm[0]["frames_rule"], llm and llm[0].get("images"))
    e.T("return T.patchSettings({ 'frames.enabled': false, 'llm.sendFrames': false })")
    e.close(tid)


@scenario
def s_long_audio(e):
    """长音频：自动分片、按序合并、失败保留进度并从失败处继续、不覆盖旧稿"""
    mock("/mock/reset")
    e.T("return T.configure({patch: {'stt.maxUploadMB': 1, 'stt.maxSliceMin': 1}})")
    e.T("return T.synthMaterial('m_long', 150)")
    r = e.T("return T.sw('material-transcribe', { materialId: 'm_long' })")
    check("转写请求被接受", r.get("ok"), r)
    e.c.wait_for(e.h, "(async () => { const m = await T.material('m_long'); return m.transcript && !m.processing; })()", timeout=60)
    m = e.T("return T.material('m_long')")
    log = [x for x in mock("/mock/log") if x["kind"] == "stt"]
    n = len(log)
    check("自动分为多片（单片 ≤ 1 MB）", n >= 5 and all(x["bytes"] <= 1048576 for x in log), [(x["duration"], x["bytes"]) for x in log])
    check("各片时长合计≈原音频（无漏无重）", abs(sum(x["duration"] for x in log) - 150) < 1.0, sum(x["duration"] for x in log))
    check("合并顺序正确", m["transcript"]["effective"].index("第1片") < m["transcript"]["effective"].index(f"第{n}片"))
    check("后续分片的 prompt 携带上一片末尾上下文", all("片第" in x["prompt"] for x in log[1:]), [x["prompt"][-20:] for x in log[:3]])
    old_text = m["transcript"]["effective"]
    # 失败：第 3 次请求返回 500
    mock("/mock/reset")
    e.T("return T.configure({sttVariant: 'stt-fail3', patch: {'stt.maxUploadMB': 1, 'stt.maxSliceMin': 1}})")
    e.T("return T.sw('material-transcribe', { materialId: 'm_long' })")
    e.c.wait_for(e.h, "(async () => { const m = await T.material('m_long'); return !m.processing && m.lastError; })()", timeout=60)
    m = e.T("return T.material('m_long')")
    check("失败定位到第 3 片", m["lastError"]["code"] == "http_server" and "第 3/" in m["lastError"]["detail"], m["lastError"])
    check("保留已完成的 2 片进度", m["sttPartial"]["failedAt"] == 2 and len(m["sttPartial"]["results"]) == 2, {"failedAt": m["sttPartial"]["failedAt"]})
    check("失败不覆盖已有完整逐字稿", m["transcript"]["effective"] == old_text)
    e.T("return T.sw('material-transcribe', { materialId: 'm_long' })")
    e.c.wait_for(e.h, "(async () => { const m = await T.material('m_long'); return !m.processing && !m.sttPartial; })()", timeout=60)
    log = [x for x in mock("/mock/log") if x["kind"] == "stt"]
    check("继续转写只发送剩余分片（3 次 + 剩余 n-2 片）", len(log) == 3 + (n - 2), (len(log), n))
    m = e.T("return T.material('m_long')")
    check("成功后才替换逐字稿并提升版本", m["transcriptVersion"] == 2 and m["transcript"]["effective"] != old_text, m["transcriptVersion"])


@scenario
def s_config_change_cancel(e):
    """处理中修改配置：停止后续发送，不偷偷重试"""
    mock("/mock/reset")
    e.T("return T.configure({sttVariant: 'stt-slow', patch: {'stt.maxUploadMB': 1, 'stt.maxSliceMin': 1}})")
    e.T("return T.synthMaterial('m_cancel', 100)")
    e.T("return T.sw('material-transcribe', { materialId: 'm_cancel' })")
    time.sleep(1.5)
    e.T("return T.patchSettings({'stt.model': 'changed-model'})")
    e.c.wait_for(e.h, "(async () => { const m = await T.material('m_cancel'); return !m.processing && m.lastError; })()", timeout=30)
    m = e.T("return T.material('m_cancel')")
    time.sleep(7)
    check("配置变更后任务停止且说明原因", m["lastError"]["code"] == "cancelled" and "配置" in m["lastError"]["detail"], m["lastError"])
    check("没有继续发送后续分片", len([x for x in mock("/mock/log") if x["kind"] == "stt"]) == 1)
    e.T("return T.configure()")


@scenario
def s_notes(e):
    """笔记：已有稿不重复 STT；只发送逐字稿；失败可定位且保留旧笔记"""
    mock("/mock/reset")
    e.T("return T.configure()")
    mats = e.T("return T.materials()")
    sub = next(x for x in mats if x["source"] == "subtitle")
    r = e.T(f"return T.sw('material-note', {{ materialId: {json.dumps(sub['id'])}, mode: 'detailed' }})")
    check("笔记请求被接受", r.get("ok"), r)
    e.c.wait_for(e.h, f"(async () => {{ const m = await T.material({json.dumps(sub['id'])}); return m.notes && m.notes.detailed && !m.processing; }})()", timeout=30)
    m = e.T(f"return T.material({json.dumps(sub['id'])})")
    log = mock("/mock/log")
    llm = [x for x in log if x["kind"] == "llm"]
    check("没有调用 STT（复用已有逐字稿）", not any(x["kind"] == "stt" for x in log))
    check("LLM 请求非流式、含模式规则", llm and llm[0]["stream"] is False and llm[0]["system_has_mode"], llm and {k: llm[0][k] for k in ("stream", "system_has_mode")})
    check("LLM 只收到逐字稿，不含标题与网址", llm and "欢迎收看" in llm[0]["user"] and "模拟视频" not in llm[0]["user"] and "bilibili.com" not in llm[0]["user"])
    check("笔记保存且去掉思考与围栏", m["notes"]["detailed"]["markdown"].startswith("# 测试笔记"))
    e.T("return T.configure({llmVariant: 'llm-html'})")
    e.T(f"return T.sw('material-note', {{ materialId: {json.dumps(sub['id'])}, mode: 'detailed' }})")
    e.c.wait_for(e.h, f"(async () => {{ const m = await T.material({json.dumps(sub['id'])}); return !m.processing && m.lastError; }})()", timeout=30)
    m = e.T(f"return T.material({json.dumps(sub['id'])})")
    check("异常可定位为“返回网页”", m["lastError"]["code"] == "html_response" and m["lastError"]["stage"] == "llm", m["lastError"])
    check("失败保留旧笔记", m["notes"]["detailed"]["markdown"].startswith("# 测试笔记"))
    e.T("return T.configure()")


@scenario
def s_real_capture_gate(e):
    """真实 tabCapture：未经工具栏/快捷键授权时给出明确的授权提示（不伪造授权）"""
    mock("/mock/reset")
    e.T("return T.configure()")
    sw = next(t for t in e.c.targets() if t["type"] == "service_worker" and e.ext_id in t["url"])
    ssid = e.c.attach(sw["targetId"])
    e.c.eval(ssid, "globalThis.__wv4uRealCapture = true")
    tid, sid, tab = e.open_page("https://www.youtube.com/watch?v=NOAD3")
    e.T(f"return T.sw('start', {{ tabId: {tab}, mode: 'current' }})")
    t = e.wait_task(["needs_action", "recording", "failed"], 15)
    check("进入“需要授权”而非静默失败或伪造", t["phase"] == "needs_action" and t["error"]["code"] == "capture_not_invoked", (t["phase"], t.get("error")))
    e.c.eval(ssid, "globalThis.__wv4uRealCapture = false")
    e.close(tid)


@scenario
def s_local_backend(e):
    """本地后端（fake 引擎）：整段一次处理、说话人编号全程一致；说话人不可用时仍得到完整普通稿"""
    import subprocess
    for diar in (True, False):
        port = 8767 if diar else 8768
        args = [sys.executable, str(ROOT / "local-backend" / "server.py"), "--engine", "fake", "--port", str(port)] + (["--fake-diarization"] if diar else [])
        p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            e.T(f"return T.configureLocal({port}, true)")
            e.T("return T.synthMaterial('m_local', 150)")
            r = e.T("return T.sw('material-transcribe', { materialId: 'm_local' })")
            check(f"[{'说话人' if diar else '无说话人'}] 本地转写请求被接受", r.get("ok"), r)
            e.c.wait_for(e.h, "(async () => { const m = await T.material('m_local'); return !m.processing && (m.transcript || m.lastError); })()", timeout=40)
            m = e.T("return T.material('m_local')")
            tr = m.get("transcript") or {}
            if diar:
                check("多人可靠时有效逐字稿为说话人分段稿（A/B 编号全程一致）", tr.get("kind") == "speaker" and tr["effective"].count("【说话人 A】") == 1 and tr["effective"].count("【说话人 B】") == 1, tr.get("effective", "")[:80])
                check("普通稿仍在内部保留", tr.get("plain") and "说话人" not in tr["plain"])
            else:
                check("说话人不可用：显示完整普通稿并记录原因", tr.get("kind") == "plain" and tr["sttMeta"]["speakers"]["error"], tr.get("sttMeta"))
        finally:
            p.terminate()
    e.T("return T.configure()")


def ui_screens(e):
    print("\n== 界面截图与控制台检查", flush=True)
    OUT.mkdir(exist_ok=True)
    mats = e.T("return T.materials()")
    mid = next((x["id"] for x in mats if x["source"] == "audio" and x["transcript"]), mats[0]["id"])
    sub = next((x["id"] for x in mats if x["source"] == "subtitle"), mid)
    pages = [
        ("popup", f"{e.base}/src/ui/popup.html", 360, 560),
        ("library", f"{e.base}/src/ui/library.html#{sub}", 1280, 860),
        ("library-audio", f"{e.base}/src/ui/library.html#{mid}", 1280, 860),
        ("library-narrow", f"{e.base}/src/ui/library.html#{sub}", 390, 800),
        ("options", f"{e.base}/src/ui/options.html", 1100, 1400),
    ]
    # 多任务：弹窗列出其他标签页的任务（注入示例任务数据，只检查界面）
    tid, sid = e.c.new_tab("about:blank")
    e.c.send("Emulation.setDeviceMetricsOverride", {"width": 360, "height": 640, "deviceScaleFactor": 1, "mobile": False}, session=sid)
    e.c.send("Page.enable", session=sid)
    e.c.send("Page.navigate", {"url": pages[0][1]}, session=sid)
    time.sleep(1.4)
    now = int(time.time() * 1000)
    fake = {
        "t_a": {"id": "t_a", "tabId": 99991, "platform": "youtube", "title": "示例视频 A：一个很长很长的标题用来检查省略号是否正常显示", "phase": "recording", "phaseText": "录音中", "startedAt": now - 5000, "audio": {"state": "recording", "seconds": 125}, "stt": {"state": "none"}, "note": {"state": "none"}, "warnings": [], "monitor": False, "materialId": "m_a"},
        "t_b": {"id": "t_b", "tabId": 99992, "platform": "bilibili", "title": "示例视频 B", "phase": "transcribing", "phaseText": "排队等待转写（前面还有 1 条）…", "startedAt": now - 9000, "audio": {"state": "saved", "seconds": 300}, "stt": {"state": "queued", "ahead": 1}, "note": {"state": "none"}, "warnings": [], "materialId": "m_b"},
        "t_c": {"id": "t_c", "tabId": 99993, "platform": "douyin", "title": "示例视频 C", "phase": "done", "phaseText": "逐字稿已保存", "startedAt": now - 20000, "finishedAt": now - 1000, "audio": {"state": "saved", "seconds": 60}, "stt": {"state": "done"}, "note": {"state": "none"}, "warnings": [], "materialId": "m_c"},
    }
    e.T(f"await chrome.storage.session.set({{ tasks: {json.dumps(fake, ensure_ascii=False)} }}); return true")
    time.sleep(0.6)
    mini = e.c.eval(sid, "({ n: document.querySelectorAll('#otherArea .mini').length, stopBtn: !!document.querySelector('#otherArea .btn.danger'), head: document.querySelector('.others-head')?.textContent || '', overflow: document.documentElement.scrollWidth > window.innerWidth + 1, clipped: [...document.querySelectorAll('main > *')].some(el => el.getBoundingClientRect().right > window.innerWidth + 1) })")
    check("界面：弹窗列出其他标签页的任务（可直接停止，显示排队与进行中数量）", mini["n"] == 3 and mini["stopBtn"] and "进行中 2" in mini["head"] and not mini["overflow"] and not mini["clipped"], mini)
    e.c.screenshot(sid, str(OUT / "popup-multi.png"))
    check("界面：多任务弹窗无脚本错误", not [x for x in e.c.console_errors(sid) if x])
    e.T("await chrome.storage.session.set({ tasks: {} }); return true")
    e.close(tid)
    # 英文界面：切换语言后不残留中文、不溢出、无脚本错误
    e.T("return T.patchSettings({ 'ui.lang': 'en' })")
    for name, url, w, hgt in [("popup-en", pages[0][1], 360, 560), ("options-en", f"{e.base}/src/ui/options.html", 1100, 900), ("library-en", pages[1][1], 1280, 860)]:
        tid, sid = e.c.new_tab("about:blank")
        e.c.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": hgt, "deviceScaleFactor": 1, "mobile": False}, session=sid)
        e.c.send("Page.enable", session=sid)
        e.c.send("Page.navigate", {"url": url}, session=sid)
        time.sleep(1.8)
        info = e.c.eval(sid, """(() => { const c = document.body.cloneNode(true); c.querySelectorAll('select, .lang-btn, .lang-switch, .t, .title, h1.d-title, .d-head h1, .src, .mini-title, article, .transcript, .kv dd').forEach(x => x.remove()); const txt = c.innerText || c.textContent || ''; const cjk = (txt.match(/[^\\n]*[\\u4e00-\\u9fff][^\\n]*/g) || []).slice(0, 5); return { lang: document.documentElement.lang, cjk, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }; })()""")
        strict = name != "library-en"
        check(f"界面：{name} 切换为英文（html lang=en{'、无残留中文' if strict else ''}、无横向溢出）", info["lang"] == "en" and (not strict or not info["cjk"]) and not info["overflow"], info)
        if name == "options-en":
            sw_ = e.c.eval(sid, "(() => { const b = [...document.querySelectorAll('.nav .lang-switch button')]; return { n: b.length, labels: b.map(x => x.textContent), pressed: b.filter(x => x.getAttribute('aria-pressed') === 'true').map(x => x.textContent), icon: !!document.querySelector('.nav .lang-switch svg') }; })()")
            check("界面：设置页侧栏有带地球图标的语言切换（中文 / English，当前为 English）", sw_["n"] == 2 and sw_["labels"] == ["中文", "English"] and sw_["pressed"] == ["English"] and sw_["icon"], sw_)
        if name == "popup-en":
            check("界面：弹窗不再放语言切换按钮", e.c.eval(sid, "!document.querySelector('.lang-btn, .lang-switch')"))
        e.c.screenshot(sid, str(OUT / f"{name}.png"))
        check(f"界面：{name} 无脚本错误", not [x for x in e.c.console_errors(sid) if x])
        e.close(tid)
    e.T("return T.patchSettings({ 'ui.lang': 'zh' })")
    # 模拟 Windows（UA + 平台元数据），检查自动密度与笔记生成区布局
    for name, url, w, h in [("win-popup", pages[0][1], 360, 560), ("win-library-notes", pages[1][1], 1280, 860)]:
        tid, sid = e.c.new_tab("about:blank")
        e.c.send("Emulation.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36", "platform": "Win32", "userAgentMetadata": {"platform": "Windows", "platformVersion": "15.0.0", "architecture": "x86", "model": "", "mobile": False}}, session=sid)
        e.c.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1.5, "mobile": False}, session=sid)
        e.c.send("Page.enable", session=sid)
        e.c.send("Page.navigate", {"url": url}, session=sid)
        time.sleep(1.6)
        dens = e.c.eval(sid, "(() => { const cs = (el) => getComputedStyle(el); const b = document.querySelector('.btn'); return { os: document.documentElement.dataset.os, root: parseFloat(cs(document.documentElement).fontSize), body: parseFloat(cs(document.body).fontSize), btnW: b ? cs(b).fontWeight : null }; })()")
        # 本机没有雅黑，字形校正为 1：根字号 = 16 × 0.875 = 14px，正文 = 14 × 0.92 ≈ 12.9px，按钮常规字重
        check(f"界面：{name} 在 Windows 上采用 Windows 配置（根 14px、正文约 12.9px、按钮常规字重）", dens["os"] == "windows" and abs(dens["root"] - 14) < 0.05 and abs(dens["body"] - 12.88) < 0.1 and dens["btnW"] in ("400", None), dens)
        if "notes" in name:
            e.c.eval(sid, "(() => { [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith('笔记')).click(); return true; })()")
            time.sleep(0.4)
            ok = e.c.eval(sid, "(() => { const g = document.querySelector('.note-gen'); if (!g) return false; const seg = g.querySelector('.seg'), btn = g.querySelector('.btn'); const a = seg.getBoundingClientRect(), b = btn.getBoundingClientRect(); return Math.abs(a.top - b.top) < 12 && b.left - a.right < 40 && !document.querySelector('.d-actions .btn.primary .x'); })()")
            check("界面：笔记风格选择器与生成按钮在同一行且相邻", ok)
            ok2 = e.c.eval(sid, "![...document.querySelectorAll('.d-actions button')].some(b => /生成.+笔记/.test(b.textContent) && /精简|详细|纪要/.test(b.textContent))")
            check("界面：顶部操作栏不再出现带风格的生成按钮", ok2)
        e.c.screenshot(sid, str(OUT / f"{name}.png"))
        check(f"界面：{name} 无脚本错误", not [x for x in e.c.console_errors(sid) if x])
        e.close(tid)
    for name, url, w, h in pages:
        for scheme in ("light", "dark"):
            tid, sid = e.c.new_tab("about:blank")
            e.c.send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": scheme}]}, session=sid)
            e.c.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, session=sid)
            e.c.send("Page.enable", session=sid)
            e.c.send("Page.navigate", {"url": url}, session=sid)
            time.sleep(1.6)
            if name == "library" and scheme == "light":
                e.c.eval(sid, "(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith('笔记')); b && b.click(); return true; })()")
                time.sleep(0.4)
                xss = e.c.eval(sid, "document.querySelectorAll('article.prose script, article.prose img').length === 0 && /<script>/.test(document.querySelector('article.prose')?.textContent || '')")
                check("界面：笔记安全渲染（脚本按文本显示）", xss)
            if scheme == "light" and name in ("popup", "options"):
                mac = e.c.eval(sid, "(() => { const b = document.querySelector('.btn'); return { os: document.documentElement.dataset.os, root: parseFloat(getComputedStyle(document.documentElement).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize), btnW: getComputedStyle(b).fontWeight }; })()")
                check(f"界面：{name} 在 macOS 上保持参考尺寸（根 16px、正文 14px、按钮中粗）", mac["os"] == "mac" and abs(mac["root"] - 16) < 0.05 and abs(mac["body"] - 14) < 0.05 and mac["btnW"] == "600", mac)
            if scheme == "light" and name == "options":
                sl = e.c.eval(sid, "(async () => { const r = document.getElementById('ui_scale'); r.value = '110'; r.dispatchEvent(new Event('input')); const live = parseFloat(getComputedStyle(document.documentElement).fontSize); r.dispatchEvent(new Event('change')); await new Promise(z => setTimeout(z, 500)); const st = (await chrome.storage.local.get('settings')).settings.ui.scale; const info = document.getElementById('ui_scale_info').textContent; r.value = '100'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); await new Promise(z => setTimeout(z, 300)); return { live, st, info }; })()")
                check("界面：界面比例滑杆实时预览并保存（110% → 根 17.6px）", abs(sl["live"] - 17.6) < 0.05 and sl["st"] == 110 and "实际 110%" in sl["info"], sl)
            if name == "library-audio" and scheme == "light":
                e.c.eval(sid, "(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('音频')); b && b.click(); return true; })()")
                time.sleep(0.5)
                nd = e.c.eval(sid, "(() => { const a = document.querySelector('audio'); return { audio: !!a, nodl: a ? a.getAttribute('controlslist') === 'nodownload' : null, btn: [...document.querySelectorAll('button')].some(b => /WAV/.test(b.textContent)) }; })()")
                check("界面：录音只能试听，不提供下载（无下载按钮、播放器隐藏下载项）", nd["audio"] and nd["nodl"] and not nd["btn"], nd)
            e.c.screenshot(sid, str(OUT / f"{name}-{scheme}.png"))
            errs = [x for x in e.c.console_errors(sid) if x]
            check(f"界面：{name}（{scheme}）无脚本错误", not errs, errs[:3])
            ov = e.c.eval(sid, "document.documentElement.scrollWidth <= window.innerWidth + 1")
            check(f"界面：{name}（{scheme}）无横向溢出", ov)
            e.close(tid)


def main():
    serve(HTTP, HTTPS, tempfile.mkdtemp(prefix="wv4u-cert-"))
    e = E2E()
    try:
        e.T("return T.clearAll()")
        check("扩展加载、Service Worker 运行", any(t["type"] == "service_worker" and e.ext_id in t["url"] for t in e.c.targets()))
        for s in [s_bili_subtitle, s_bili_fallback, s_bili_mismatch, s_bili_incomplete_login, s_youtube_ad, s_douyin_loop, s_duplicate_and_switch, s_manual_stop, s_multi_tab, s_frames, s_long_audio, s_config_change_cancel, s_notes, s_real_capture_gate, s_local_backend]:
            s(e)
        ui_screens(e)
    finally:
        e.c.close()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    for n, _, d in failed:
        print("  FAILED:", n, d)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
