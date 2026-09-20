import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { hostelAnalytics } from "@/lib/hostel-engine/analytics";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The platform's view of the hostel business: occupancy, the booking pipeline,
 * money in and out, and who is carrying it. Admin only — a landlord's own
 * numbers belong on the landlord's screen, not in a shared totals page.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-analytics", { limit: 60, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return Response.json({ ok: true, analytics: await hostelAnalytics() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
