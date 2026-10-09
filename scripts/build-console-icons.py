#!/usr/bin/env python3
"""Render the console's vector mark into home-screen and browser icons."""

from io import BytesIO
from pathlib import Path
import subprocess

from PIL import Image


PUBLIC = Path(__file__).resolve().parent.parent / "public"
MARK = PUBLIC / "console-mark.svg"
BACKGROUND = "#152337"


def render(size: int) -> Image.Image:
    result = subprocess.run(
        ["magick", "-background", "none", str(MARK), "-resize", f"{size}x{size}!", "png:-"],
        check=True,
        capture_output=True,
    )
    return Image.open(BytesIO(result.stdout)).convert("RGBA")


def maskable(size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BACKGROUND)
    inner = round(size * 0.76)
    inset = (size - inner) // 2
    canvas.alpha_composite(render(inner), (inset, inset))
    return canvas


def main() -> None:
    for size in (192, 512):
        render(size).save(PUBLIC / f"console-icon-{size}.png")
        maskable(size).save(PUBLIC / f"console-icon-maskable-{size}.png")
    render(180).save(PUBLIC / "console-apple-touch-icon.png")
    render(48).save(PUBLIC / "console-favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == "__main__":
    main()
