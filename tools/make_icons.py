"""Draws icons/icon-192.png and icons/icon-512.png to match icons/icon.svg.

Plain Python, no libraries. Run: python3 tools/make_icons.py
"""
import struct
import zlib
from pathlib import Path

GREEN = (0x2F, 0x6B, 0x4F)
WHITE = (0xFF, 0xFF, 0xFF)
PIPS = [(186, 186), (326, 186), (256, 256), (186, 326), (326, 326)]


def in_round_rect(x, y, x0, y0, size, r):
    cx = min(max(x, x0 + r), x0 + size - r)
    cy = min(max(y, y0 + r), y0 + size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x0 + size and y0 <= y <= y0 + size


def colour_at(x, y):
    """Colour at a point in the 512-unit design, or None outside the icon."""
    if not in_round_rect(x, y, 0, 0, 512, 96):
        return None
    if in_round_rect(x, y, 116, 116, 280, 48):
        if any((x - px) ** 2 + (y - py) ** 2 <= 30 * 30 for px, py in PIPS):
            return GREEN
        return WHITE
    return GREEN


def render(size, samples=3):
    rows = []
    scale = 512 / size
    for j in range(size):
        row = bytearray([0])  # PNG filter: none
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(samples):
                for si in range(samples):
                    c = colour_at((i + (si + 0.5) / samples) * scale, (j + (sj + 0.5) / samples) * scale)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = samples * samples
            alpha = acc[3] / n
            if alpha:
                row += bytes(round(acc[k] * 255 / acc[3]) for k in range(3)) + bytes([round(alpha)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


out = Path(__file__).resolve().parent.parent / "icons"
for size in (192, 512):
    (out / f"icon-{size}.png").write_bytes(png(size, render(size)))
    print("wrote", out / f"icon-{size}.png")
