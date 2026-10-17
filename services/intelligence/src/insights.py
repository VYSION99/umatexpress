"""Deterministic insights from aggregate hostel booking counts (no student data)."""

from dataclasses import dataclass


@dataclass(frozen=True)
class DailyBookings:
    day: str
    count: int


def booking_insights(days: list[DailyBookings], occupied: int, total: int) -> dict:
    counts = [day.count for day in days[-14:]]
    current = sum(counts[-7:])
    previous = sum(counts[-14:-7])
    change = current - previous
    occupancy_rate = round(occupied / total, 4) if total else 0

    messages = []
    if len(counts) >= 14:
        if change > 0:
            messages.append(f"Paid bookings rose by {change} in the last seven days compared with the preceding seven days.")
        elif change < 0:
            messages.append(f"Paid bookings fell by {abs(change)} in the last seven days compared with the preceding seven days.")
        else:
            messages.append("Paid bookings were unchanged across the two seven-day periods.")
    if total:
        messages.append(f"{total - occupied} of {total} bed spaces are currently available.")

    return {
        "currentWeekBookings": current,
        "previousWeekBookings": previous,
        "weekChange": change,
        "occupancyRate": occupancy_rate,
        "messages": messages,
        "method": "Seven-day comparison of paid bookings; occupancy from current bed-space totals. No forecast is implied.",
    }
