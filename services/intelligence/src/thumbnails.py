"""Select a representative browser-extracted video frame without video codecs."""

from math import isfinite


def choose_thumbnail(frames: list[dict]) -> int:
    """Prefer a well-lit, detailed frame; keep the earliest frame on a tie."""
    if not frames:
        raise ValueError("At least one frame is required")

    def score(frame: dict) -> float:
        brightness = float(frame["brightness"])
        contrast = float(frame["contrast"])
        if not isfinite(brightness) or not isfinite(contrast):
            raise ValueError("Frame metrics must be finite")
        # Dark credits and blown-out transitions are poor thumbnails.
        exposure = max(0.0, 1.0 - abs(brightness - 0.52) / 0.52)
        return exposure * 0.65 + min(contrast, 1.0) * 0.35

    return max(range(len(frames)), key=lambda index: score(frames[index]))
