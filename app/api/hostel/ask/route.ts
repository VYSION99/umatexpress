import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { askHostelAssistant } from "@/lib/hostel-engine/assistant";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The public "ask about this hostel" card. Reading the catalogue is anonymous,
 * so this is too — which is why it is held to a strict rate limit and answers
 * from the listing's own public facts, never from the database at large.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-ask", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: unknown; question?: unknown };
    const result = await askHostelAssistant({ propertyId: body.propertyId, question: body.question });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
