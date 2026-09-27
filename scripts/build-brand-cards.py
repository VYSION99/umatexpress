#!/usr/bin/env python3
"""Derive the homepage card artwork from the full service posters.

The posters in `public/brand/` are 3:2 marketing pieces: a brand lockup and
headline across the top, a photo in the middle, and a feature strip along the
bottom. A homepage service card already prints the service name, so the card
image keeps the lockup and photography and crops the feature strip away — both
because the strip's 10px lettering is unreadable at card size and because it
would repeat what the card's own text already says.

Run after a poster changes:

    python3 scripts/build-brand-cards.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "public" / "brand"

# Keeps the lockup, the headline and the photo, and stops above the feature
# strip: the earliest strip starts at y=728, so 720 leaves its icons out of every
# poster instead of letting one bleed through at the bottom edge.
CARD_BOX = (0, 0, 1536, 720)
CARD_SIZE = (840, 394)

POSTERS = {
    "campusride": "campusride.webp",
    "vacationride": "vacationride.webp",
    "hostelfinder": "hostelfinder.webp",
    "cinema": "cinema.webp",
}


def main() -> None:
    for slug, filename in POSTERS.items():
        source = BRAND / filename
        poster = Image.open(source).convert("RGB")
        card = poster.crop(CARD_BOX).resize(CARD_SIZE, Image.LANCZOS)
        target = BRAND / f"{slug}-card.webp"
        card.save(target, "WEBP", quality=82, method=6)
        print(f"{target.name:24} {card.size[0]}x{card.size[1]}  {target.stat().st_size / 1024:6.1f} KB")


if __name__ == "__main__":
    main()
