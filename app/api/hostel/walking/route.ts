import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { getHostelWalkingRoute } from "@/lib/hostel-engine/walking";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "private, max-age=300" };
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-walking-read", { limit: 30, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const route = await getHostelWalkingRoute(url.searchParams.get("propertyId") || "", url.searchParams.get("destinationId") || "");
    return Response.json({ ok: true, route }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
}
