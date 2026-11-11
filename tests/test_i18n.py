#!/usr/bin/env python3
"""界面翻译覆盖检查：扫描扩展界面相关源码中的中文文案，确认每条都有英文译文（或在不翻译清单中）。"""
import json
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "extension" / "src"
FILES = ["ui/popup.js", "ui/library.js", "ui/options.js", "ui/ui.js", "content/content.js", "background/sw.js", "offscreen/jobs.js", "offscreen/recorder.js", "shared/errors.js", "shared/format.js", "shared/bilibili.js", "shared/http.js", "shared/i18n.js"]
HTML = ["ui/popup.html", "ui/library.html", "ui/options.html"]
# 有意不翻译：语言名、切换按钮、发给转写服务的默认提示、内部匹配用前缀、offscreen 文档用途说明（不显示给用户）
SKIP = {"简体中文", "中", "检测到", "以下是普通话的句子，使用简体中文和标点符号，如逗号、句号、问号。", "录制你授权的标签页声音，并在后台把录音分片发送给你配置的转写/笔记服务。"}
CJK = re.compile(r"[一-鿿]")
LIT = re.compile(r"""'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`""", re.S)


def strip_comments(src):
    out = []
    for ln in src.split("\n"):
        st = ln.strip()
        if st.startswith(("//", "*", "/*")):
            out.append("")
            continue
        out.append(re.sub(r"(?<![:'\"])\s//\s.*$", "", ln))
    return "\n".join(out)


def keys():
    found = []
    for f in FILES:
        src = strip_comments((SRC / f).read_text())
        for m in LIT.finditer(src):
            x = m.group(0)
            body = x[1:-1]
            if not CJK.search(body):
                continue
            if x[0] == "`" and "${" in body:
                inner = re.findall(r"'((?:[^'\\]|\\.)*)'", body)
                for s in inner:
                    if CJK.search(s):
                        found.append((f, "KEY", s))
                # 模板中除被翻译调用包住的字符串外，不应再直接写中文
                if CJK.search(re.sub(r"'(?:[^'\\]|\\.)*'", "", body)):
                    found.append((f, "TEMPLATE", body[:80]))
                continue
            found.append((f, "KEY", body.replace("\\'", "'").replace('\\"', '"')))
    p = (SRC / "shared/prompts.js").read_text()
    block = re.search(r"export const NOTE_MODES = \{([\s\S]*?)\n\};", p).group(1)
    for m in re.finditer(r"(?:label|hint): '([^']+)'", block):
        found.append(("shared/prompts.js", "KEY", m.group(1)))
    for f in HTML:
        src = (SRC / f).read_text()
        for m in re.finditer(r">([^<>]*[一-鿿][^<>]*)<", src):
            found.append((f, "KEY", m.group(1).strip()))
        for m in re.finditer(r'(?:title|aria-label|placeholder)="([^"]*[一-鿿][^"]*)"', src):
            found.append((f, "KEY", m.group(1)))
    return found


def dictionary():
    js = (SRC / "shared/i18n-en.js").read_text()
    body = js[js.index("{"): js.rindex("}") + 1]
    return json.loads(re.sub(r",\s*}$", "}", body))


def main():
    en = dictionary()
    missing, templates = [], []
    for f, kind, s in keys():
        if kind == "TEMPLATE":
            templates.append(f"{f}: {s}")
        elif s not in en and s not in SKIP:
            missing.append(f"{f}: {s}")
    bad_params = [k for k, v in en.items() if sorted(re.findall(r"\{(\w+)\}", k)) != sorted(re.findall(r"\{(\w+)\}", v))]
    ok = True
    for title, items in (("缺少英文译文", missing), ("含中文的模板字符串（请改用 t('…{x}…', {x})）", templates), ("译文占位符与原文不一致", bad_params)):
        print(("PASS " if not items else "FAIL ") + title + (f"：{len(items)} 条" if items else ""))
        for i in items[:30]:
            print("     " + i)
        ok = ok and not items
    print(f"\n词典 {len(en)} 条")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
