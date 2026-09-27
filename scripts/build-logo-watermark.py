#!/usr/bin/env python3
"""Derive public/logo-watermark.png — the hero's watermark — from the mark.

public/logo-mark.png is drawn as a luminous leaf on a near-black plate, so
luminance is already the cut-out: the plate sits at (1,1,1) to (5,30,6) and the
leaf and its circuit run bright. Mapping luminance onto alpha drops the plate
and its film grain, and the floor clears the outer glow, which would otherwise
read as a grey smudge once the mark is faded onto a white page. Run after the
mark changes:

    python3 scripts/build-logo-watermark.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public" / "logo-mark.png"
TARGET = ROOT / "public" / "logo-watermark.png"

# Anything at or below FLOOR becomes fully transparent; anything at or above
# CEILING stays fully opaque. The plate grain measures ~0.05 and the glow
# ~0.12, so a little under 0.2 removes both without eating the circuit traces.
FLOOR = 0.18
CEILING = 0.60


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    width, height = source.size
    pixels = source.load()
    cut = Image.new("RGBA", (width, height))
    out = cut.load()

    for y in range(height):
        for x in range(width):
            red, green, blue = pixels[x, y]
            luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
            alpha = (luminance - FLOOR) / (CEILING - FLOOR)
            if alpha <= 0:
                alpha = 0.0
            elif alpha >= 1:
                alpha = 1.0
            else:
                alpha = alpha ** 0.85
            out[x, y] = (red, green, blue, round(alpha * 255))

    cut.save(TARGET, optimize=True)
    print(f"wrote {TARGET.relative_to(ROOT)} {cut.size[0]}x{cut.size[1]}")


if __name__ == "__main__":
    main()
