import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parent / "src"))
sys.modules.setdefault("workers", SimpleNamespace(asgi=SimpleNamespace(entrypoint=lambda app: app)))

from insights import DailyBookings, booking_insights
from main import AnalyticsInput, DailyBookingsInput, GenerateInput, ai_text, generate, hostel_insights


class IntelligenceTests(unittest.TestCase):
    def test_analytics_uses_only_aggregate_counts(self):
        days = [DailyBookings(f"2026-10-{day:02d}", 1 if day <= 7 else 2) for day in range(1, 15)]
        result = booking_insights(days, occupied=3, total=5)
        self.assertEqual(result["previousWeekBookings"], 7)
        self.assertEqual(result["currentWeekBookings"], 14)
        self.assertEqual(result["weekChange"], 7)
        self.assertEqual(result["occupancyRate"], 0.6)
        self.assertIn("2 of 5", result["messages"][1])

    def test_invalid_occupancy_is_rejected(self):
        payload = AnalyticsInput(days=[DailyBookingsInput(day="2026-10-01", count=1)], occupied=3, total=2)
        with self.assertRaises(HTTPException) as invalid:
            asyncio.run(hostel_insights(payload))
        self.assertEqual(invalid.exception.status_code, 422)

    def test_ai_result_formats(self):
        self.assertEqual(ai_text({"response": "Answer"}), "Answer")
        self.assertEqual(ai_text({"choices": [{"message": {"content": "Reply"}}]}), "Reply")

    def test_ai_uses_workers_ai_binding(self):
        ai = SimpleNamespace(run=AsyncMock(return_value={"response": "Answer"}))
        request = SimpleNamespace(scope={"env": SimpleNamespace(AI=ai, CLOUDFLARE_AI_MODEL="test-model")})
        result = asyncio.run(generate(GenerateInput(systemPrompt="system", userPrompt="user"), request))
        self.assertEqual(result, {"text": "Answer"})
        ai.run.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
