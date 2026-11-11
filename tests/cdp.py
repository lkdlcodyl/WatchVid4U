"""最小化的 Chrome DevTools Protocol 客户端（--remote-debugging-pipe，纯标准库）。"""
import fcntl
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time

CHROME = os.environ.get("WV4U_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


class CDPError(Exception):
    pass


class Chrome:
    def __init__(self, extra_args=(), headless=True):
        self.profile = tempfile.mkdtemp(prefix="wv4u-profile-")
        r_cmd, w_cmd = os.pipe()  # 我们写 → Chrome 从 fd3 读
        r_out, w_out = os.pipe()  # Chrome 写 fd4 → 我们读
        args = [
            CHROME,
            f"--user-data-dir={self.profile}",
            "--remote-debugging-pipe",
            "--enable-unsafe-extension-debugging",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-background-networking",
            "--disable-component-update",
            "--autoplay-policy=no-user-gesture-required",
            "--password-store=basic",
            "--use-mock-keychain",
            "--window-size=1280,900",
            *extra_args,
        ]
        if headless:
            args.insert(1, "--headless=new")

        def child_fds():
            # 先复制到高位再放到 3/4，避免编号冲突；dup2 产生的描述符可被 exec 继承
            a = fcntl.fcntl(r_cmd, fcntl.F_DUPFD, 20)
            b = fcntl.fcntl(w_out, fcntl.F_DUPFD, 20)
            os.dup2(a, 3)
            os.dup2(b, 4)

        self.proc = subprocess.Popen(args + ["about:blank"], close_fds=False, preexec_fn=child_fds, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(r_cmd)
        os.close(w_out)
        self.wfd = w_cmd
        self.rfd = r_out
        self.next_id = 1
        self.pending = {}
        self.events = []
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()

    def _read_loop(self):
        buf = b""
        while True:
            try:
                chunk = os.read(self.rfd, 1 << 16)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\0" in buf:
                raw, buf = buf.split(b"\0", 1)
                msg = json.loads(raw.decode("utf-8"))
                with self.cond:
                    if "id" in msg:
                        self.pending[msg["id"]] = msg
                    else:
                        self.events.append(msg)
                        if len(self.events) > 5000:
                            self.events = self.events[-2000:]
                    self.cond.notify_all()

    def send(self, method, params=None, session=None, timeout=60):
        with self.lock:
            mid = self.next_id
            self.next_id += 1
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        os.write(self.wfd, json.dumps(msg).encode("utf-8") + b"\0")
        end = time.time() + timeout
        with self.cond:
            while mid not in self.pending:
                left = end - time.time()
                if left <= 0:
                    raise CDPError(f"timeout waiting for {method}")
                self.cond.wait(left)
            r = self.pending.pop(mid)
        if "error" in r:
            raise CDPError(f"{method}: {r['error']}")
        return r.get("result", {})

    # ---- 便捷方法
    def targets(self):
        return self.send("Target.getTargets")["targetInfos"]

    def attach(self, target_id):
        return self.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]

    def new_tab(self, url):
        tid = self.send("Target.createTarget", {"url": url})["targetId"]
        sid = self.attach(tid)
        self.send("Runtime.enable", session=sid)
        return tid, sid

    def eval(self, sid, expr, timeout=60, await_promise=True):
        r = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True, "userGesture": True}, session=sid, timeout=timeout)
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise CDPError("JS exception: " + json.dumps(d.get("exception", {}).get("description") or d.get("text"), ensure_ascii=False))
        return r["result"].get("value")

    def wait_for(self, sid, expr, timeout=30, interval=0.25):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            last = self.eval(sid, expr)
            if last:
                return last
            time.sleep(interval)
        raise CDPError(f"wait_for timeout: {expr} (last={last!r})")

    def screenshot(self, sid, path, width=None, height=None, scale=1):
        if width:
            self.send("Emulation.setDeviceMetricsOverride", {"width": width, "height": height or 800, "deviceScaleFactor": scale, "mobile": False}, session=sid)
        import base64

        data = self.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False}, session=sid)["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))

    def console_errors(self, sid=None):
        out = []
        with self.lock:
            for e in self.events:
                if sid and e.get("sessionId") != sid:
                    continue
                if e.get("method") == "Runtime.exceptionThrown":
                    out.append(e["params"]["exceptionDetails"].get("exception", {}).get("description") or e["params"]["exceptionDetails"].get("text"))
                if e.get("method") == "Runtime.consoleAPICalled" and e["params"].get("type") == "error":
                    out.append(" ".join(str(a.get("value", a.get("description", ""))) for a in e["params"].get("args", [])))
        return out

    def close(self):
        try:
            self.send("Browser.close", timeout=5)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)
