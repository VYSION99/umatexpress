import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { campusRatingBreakdown, listCampusRatings } from "@/lib/campus-engine/feedback";
import { requireConsoleRole } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * What passengers said about the rides, for the person who can act on it.
 *
 * Read-only on purpose: a rating is a score and this is where it is watched,
 * while a complaint is a dispute and belongs in the queue with a decision
 * attached to it. Weakening that line is how a rating becomes a support ticket.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "campus-feedback-console", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const [ratings, breakdown] = await Promise.all([listCampusRatings({ limit: 100 }), campusRatingBreakdown()]);
    return Response.json({ ok: true, ratings, ...breakdown }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
