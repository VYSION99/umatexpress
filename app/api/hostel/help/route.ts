import { answerHostelGuide } from "@/lib/hostel-engine/help-assistant";
import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-public-guide-ai", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { question?: unknown };
    return Response.json({ ok: true, ...(await answerHostelGuide(body.question, "student")) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
