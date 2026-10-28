#!/usr/bin/env python3
"""Generates the PNG icons used by the app and installer. No dependencies."""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, width, height, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y]) for y in range(height))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def rounded_rect_alpha(x, y, w, h, r, px, py):
    """Coverage of a rounded rect centred in the given box."""
    dx = max(abs(px - (x + w / 2)) - (w / 2 - r), 0)
    dy = max(abs(py - (y + h / 2)) - (h / 2 - r), 0)
    return 1.0 if math.hypot(dx, dy) <= r else 0.0


def bubble_alpha(px, py, W, H):
    """White speech bubble with a tail, expressed in a 0..1 space."""
    x = px / W
    y = py / H
    # Rounded body
    cx, cy = 0.5, 0.45
    bw, bh, r = 0.60, 0.34, 0.10
    dx = max(abs(x - cx) - (bw / 2 - r), 0)
    dy = max(abs(y - cy) - (bh / 2 - r), 0)
    if math.hypot(dx, dy) <= r:
        return 1.0
    # Tail
    if 0.30 <= x <= 0.46 and 0.60 <= y <= 0.74:
        t = (y - 0.60) / 0.14
        if x <= 0.46 - t * 0.16:
            return 1.0
    return 0.0


def make(size, path, template=False):
    px = []
    for y in range(size):
        row = []
        for x in range(size):
            if template:
                a = bubble_alpha(x, y, size, size)
                # macOS template: solid black with alpha in the alpha channel
                row += [0, 0, 0, int(255 * a)]
                continue

            outer = rounded_rect_alpha(0, 0, size, size, size * 0.22, x, y)
            if outer <= 0:
                row += [0, 0, 0, 0]
                continue
            # vertical gradient
            t = y / max(1, size - 1)
            r = int(92 + (38 - 92) * t)
            g = int(141 + (96 - 141) * t)
            b = int(255 + (212 - 255) * t)
            # bubble
            ba = bubble_alpha(x, y, size, size)
            if ba > 0:
                r = int(r + (255 - r) * ba)
                g = int(g + (255 - g) * ba)
                b = int(b + (255 - b) * ba)
            # subtle top highlight
            row += [r, g, b, int(255 * outer)]
        px.append(row)
    write_png(path, size, size, px)
    print("wrote", path)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    make(512, os.path.join(OUT, "icon.png"))
    make(32, os.path.join(OUT, "tray.png"))
    make(32, os.path.join(OUT, "trayTemplate.png"), template=True)
    make(64, os.path.join(OUT, "trayTemplate@2x.png"), template=True)
