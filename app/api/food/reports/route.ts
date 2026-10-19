import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { reportFoodListing } from "@/lib/food/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin report refused.", 403);
    const limited = await rateLimit(request, "food-listing-report", { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { providerId?: unknown; category?: unknown; message?: unknown };
    return Response.json({ ok: true, report: await reportFoodListing({ providerId: body.providerId, category: body.category, message: body.message }) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, body } = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the correction details.", 400) : error);
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
