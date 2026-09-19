#!/usr/bin/env python3
"""Derive the installer icons from public/logo.png.

The master artwork is not square and carries the wordmark, so the app icon is a
square crop of the emblem. Maskable icons keep the emblem inside the 80% safe
zone and let the artwork's own dark background bleed to the edges, which is what
Android's adaptive icon mask expects. Run after the logo changes:

    python3 scripts/build-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

# Square crop of the glowing leaf and circuit emblem, stopping above the
# wordmark: "UmatExpress" starts around y=558 in the 1080x858 master, and an app
# icon that carries sliced-off lettering reads as a mistake.
EMBLEM_BOX = (270, 0, 822, 552)


def bleed(image: Image.Image, pad: int) -> Image.Image:
    """Grow a square image by stretching its own edges and corners outward."""
    width, height = image.size
    canvas = Image.new("RGB", (width + pad * 2, height + pad * 2))
    canvas.paste(image, (pad, pad))
    edges = [
        (image.crop((0, 0, width, 1)), (width, pad), (pad, 0)),
        (image.crop((0, height - 1, width, height)), (width, pad), (pad, height + pad)),
        (image.crop((0, 0, 1, height)), (pad, height), (0, pad)),
        (image.crop((width - 1, 0, width, height)), (pad, height), (width + pad, pad)),
        (image.crop((0, 0, 1, 1)), (pad, pad), (0, 0)),
        (image.crop((width - 1, 0, width, 1)), (pad, pad), (width + pad, 0)),
        (image.crop((0, height - 1, 1, height)), (pad, pad), (0, height + pad)),
        (image.crop((width - 1, height - 1, width, height)), (pad, pad), (width + pad, height + pad)),
    ]
    for strip, box, position in edges:
        canvas.paste(strip.resize(box, Image.NEAREST), position)
    return canvas


def main() -> None:
    master = Image.open(PUBLIC / "logo.png").convert("RGB")
    emblem = master.crop(EMBLEM_BOX)

    for size in (192, 512):
        emblem.resize((size, size), Image.LANCZOS).save(PUBLIC / f"icon-{size}.png")
        # A maskable icon needs the mark inside the central safe zone so a
        # circular or squircle mask can never clip the leaf. The surround keeps
        # the artwork's own edge colours, stretched outward, so no seam or flat
        # halo appears once the launcher masks it.
        inner = round(size * 0.76)
        canvas = bleed(emblem.resize((inner, inner), Image.LANCZOS), (size - inner) // 2)
        canvas.save(PUBLIC / f"icon-maskable-{size}.png")

    inner = round(180 * 0.92)
    bleed(emblem.resize((inner, inner), Image.LANCZOS), (180 - inner) // 2).save(PUBLIC / "apple-touch-icon.png")

    print("wrote icon-192.png, icon-512.png, icon-maskable-192.png, icon-maskable-512.png, apple-touch-icon.png")


if __name__ == "__main__":
    main()
