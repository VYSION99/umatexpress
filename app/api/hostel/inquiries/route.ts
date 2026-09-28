import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { createHostelAiInquiry } from "@/lib/hostel-engine/ai-desk";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-ai-inquiry", { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: unknown; question?: unknown; name?: unknown; email?: unknown; assistantAnswer?: unknown };
    return Response.json({ ok: true, inquiry: await createHostelAiInquiry(body) }, { status: 201, headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
