#!/usr/bin/env python3
"""打包：dist/WatchVid4U-<版本>.zip（扩展，可直接加载/上传）与 dist/WatchVid4U-local-backend-<版本>.zip（可选本地后端）。
扩展包只包含 extension/ 下的运行文件；不含测试、后端环境、模型、密钥或用户数据。"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"
SKIP = {".DS_Store", "Thumbs.db"}


def main():
    version = json.loads((EXT / "manifest.json").read_text())["version"]
    DIST.mkdir(exist_ok=True)
    ext_zip = DIST / f"WatchVid4U-{version}.zip"
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and p.name not in SKIP)
    with zipfile.ZipFile(ext_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(EXT).as_posix())
    be_zip = DIST / f"WatchVid4U-local-backend-{version}.zip"
    with zipfile.ZipFile(be_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted((ROOT / "local-backend").rglob("*")):
            if p.is_file() and p.name not in SKIP and "__pycache__" not in p.parts:
                z.write(p, ("local-backend/" + p.relative_to(ROOT / "local-backend").as_posix()))
    # 自检：引用的资源都存在，没有测试/密钥类文件
    m = json.loads((EXT / "manifest.json").read_text())
    refs = list(m["icons"].values()) + list(m["action"]["default_icon"].values()) + [m["background"]["service_worker"], m["action"]["default_popup"], m["options_page"]]
    for cs in m["content_scripts"]:
        refs += cs["js"]
    names = {p.relative_to(EXT).as_posix() for p in files}
    missing = [r for r in refs if r not in names]
    bad = [n for n in names if any(k in n.lower() for k in ("test", ".env", "secret", ".pem", ".key"))]
    assert not missing, f"manifest 引用缺失: {missing}"
    assert not bad, f"扩展包含不应发布的文件: {bad}"
    print(f"{ext_zip.relative_to(ROOT)}  {ext_zip.stat().st_size // 1024} KB, {len(files)} files")
    print(f"{be_zip.relative_to(ROOT)}  {be_zip.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
