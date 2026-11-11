#!/usr/bin/env python3
"""用纯 Python（无第三方依赖）栅格化扩展图标：圆角方块 + 播放三角 + 两行“文字”线。
输出 extension/icons/icon-{16,32,48,128}.png 与 icon.svg（设计源）。"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
TOP = (0x3D, 0x5A, 0xE6)
BOT = (0x2A, 0x3F, 0xB0)
WHITE = (255, 255, 255)
LINE = (0xFF, 0xD8, 0x6B)


def rounded_rect(x, y, s, r):
    # 坐标归一化到 [0,1]
    if x < 0 or y < 0 or x > 1 or y > 1:
        return False
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def in_capsule(px, py, x1, x2, y, half):
    cx = min(max(px, x1), x2)
    return (px - cx) ** 2 + (py - y) ** 2 <= half * half


def shade(x, y, size):
    if not rounded_rect(x, y, size, 0.24):
        return None
    t = y
    col = tuple(int(TOP[i] * (1 - t) + BOT[i] * t) for i in range(3))
    small = size <= 16
    # 播放三角（小尺寸时放大居中）
    if small:
        tri = ((0.30, 0.22), (0.30, 0.78), (0.78, 0.50))
    else:
        tri = ((0.27, 0.22), (0.27, 0.64), (0.62, 0.43))
    if in_triangle(x, y, *tri):
        return WHITE
    if not small:
        if in_capsule(x, y, 0.27, 0.74, 0.77, 0.045):
            return LINE
        if in_capsule(x, y, 0.27, 0.55, 0.88 - 0.0, 0.0) :
            pass
        if in_capsule(x, y, 0.62, 0.74, 0.62, 0.045) and size >= 48:
            return (230, 236, 255)
    return col


def render(size, ss=6):
    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    x = (i + (si + 0.5) / ss) / size
                    y = (j + (sj + 0.5) / ss) / size
                    c = shade(x, y, size)
                    if c is not None:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                cover = acc[3] / 255
                row += bytes([int(acc[0] / cover), int(acc[1] / cover), int(acc[2] / cover), int(round(a))])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    return rows


def png(size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D5AE6"/><stop offset="1" stop-color="#2A3FB0"/></linearGradient></defs>
  <rect width="128" height="128" rx="30.7" fill="url(#g)"/>
  <path d="M34.6 28.2v53.7L79.4 55z" fill="#fff"/>
  <path d="M79.4 79.4h15.4" stroke="#E6ECFF" stroke-width="11.5" stroke-linecap="round"/>
  <path d="M34.6 98.6h60.2" stroke="#FFD86B" stroke-width="11.5" stroke-linecap="round"/>
</svg>
"""

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (16, 32, 48, 128):
        (OUT / f"icon-{s}.png").write_bytes(png(s, render(s, 6 if s < 128 else 3)))
        print("wrote", OUT / f"icon-{s}.png")
    (OUT / "icon.svg").write_text(SVG, encoding="utf-8")
