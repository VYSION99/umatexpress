import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listHostelPeriods } from "@/lib/hostel-engine/periods";
import { withEdgeCache } from "@/lib/edge-cache";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The open academic years, for students and for the landlord's pricing form.
 * Only the fields a visitor needs: the review record and the internal ids the
 * platform uses to moderate stay on the console side.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-periods-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    // Landlords price against these years and students filter by them, so the
    // answer is shared by every visitor for a minute at a time.
    return await withEdgeCache(request, { path: "/api/hostel/periods", maxAge: 60, staleWhileRevalidate: 600 }, async () => {
      const periods = await listHostelPeriods();
      return Response.json({
        ok: true,
        periods: periods.map((period) => ({ id: period.id, name: period.name, starts_on: period.startsOn, ends_on: period.endsOn })),
      }, { headers: NO_STORE });
    });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
