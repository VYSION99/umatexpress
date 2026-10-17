"""Private Cloudflare Python Worker for AI and aggregate hostel insights."""

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from workers import asgi

from insights import DailyBookings, booking_insights

app = FastAPI(title="UMATeXPRESS Intelligence", docs_url=None, redoc_url=None, openapi_url=None)
Default = asgi.entrypoint(app)


class DailyBookingsInput(BaseModel):
    day: str = Field(min_length=10, max_length=10, pattern=r"^\d{4}-\d{2}-\d{2}$")
    count: int = Field(ge=0)


class AnalyticsInput(BaseModel):
    days: list[DailyBookingsInput] = Field(min_length=1, max_length=14)
    occupied: int = Field(ge=0)
    total: int = Field(ge=0)


class GenerateInput(BaseModel):
    systemPrompt: str = Field(min_length=1, max_length=12000)
    userPrompt: str = Field(min_length=1, max_length=24000)


@app.post("/v1/analytics/hostels/insights")
async def hostel_insights(payload: AnalyticsInput):
    if payload.occupied > payload.total:
        raise HTTPException(status_code=422, detail="Occupied spaces exceed total spaces")
    return booking_insights(
        [DailyBookings(day=row.day, count=row.count) for row in payload.days],
        payload.occupied,
        payload.total,
    )


def ai_text(result: object) -> str:
    """Read either Workers AI response format after crossing the JS/Python boundary."""
    if hasattr(result, "to_py"):
        result = result.to_py()
    if not isinstance(result, dict):
        return ""
    response = result.get("response")
    if isinstance(response, str) and response.strip():
        return response.strip()
    choices = result.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"].strip()
    return ""


@app.post("/v1/ai/generate")
async def generate(payload: GenerateInput, request: Request):
    env = request.scope["env"]
    model = getattr(env, "CLOUDFLARE_AI_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
    try:
        result = await env.AI.run(model, {
            "messages": [
                {"role": "system", "content": payload.systemPrompt},
                {"role": "user", "content": payload.userPrompt},
            ],
            "max_tokens": 2048,
            "temperature": 0.2,
        })
    except Exception as exc:
        raise HTTPException(status_code=502, detail="AI provider unavailable") from exc
    text = ai_text(result)
    if not text:
        raise HTTPException(status_code=502, detail="AI provider returned no text")
    return {"text": text}
