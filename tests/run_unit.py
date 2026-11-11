#!/usr/bin/env python3
"""在无头 Chrome 中运行浏览器内单测（含模拟 STT/LLM 服务的协议测试）。"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import Chrome  # noqa: E402
from server import serve  # noqa: E402

HTTP, HTTPS = 8790, 8791


def main():
    serve(HTTP, HTTPS, tempfile.mkdtemp(prefix="wv4u-cert-"))
    c = Chrome()
    try:
        _, sid = c.new_tab(f"http://127.0.0.1:{HTTP}/tests/unit/index.html")
        res = c.wait_for(sid, "window.__results", timeout=120)
        for r in res["results"]:
            print(("PASS " if r["ok"] else "FAIL ") + r["name"] + ("" if r["ok"] else "\n     " + r["error"]))
        errs = [e for e in c.console_errors(sid) if e]
        if errs:
            print("\nconsole errors:", json.dumps(errs, ensure_ascii=False, indent=1))
        print(f"\n{res['total'] - res['failed']}/{res['total']} passed")
        return 1 if res["failed"] else 0
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
