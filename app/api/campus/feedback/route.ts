import { CampusEngineError } from "@/lib/campus-engine/errors";
import { campusFeedbackState, loadCampusRatedTrip, rateCampusTrip, reportCampusTrip } from "@/lib/campus-engine/feedback";
import { requireCampusPassenger } from "@/lib/campus-engine/passenger-access";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { ensureCampusRideTables } from "@/lib/campus-ride";
import { isTursoConfiguredRuntime } from "@/lib/turso";

/**
 * Rating a trip, and saying something went wrong.
 *
 * Both are the passenger's own act on their own seat, so both go through the
 * same door as the ticket and the cancel: the payment cookie or the account.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-feedback-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before reading campusRide feedback.", 503);
    await ensureCampusRideTables();
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing campusRide payment reference.", 400);
    const trip = await loadCampusRatedTrip(reference);
    if (!trip) throw new CampusEngineError("NOT_FOUND", "campusRide booking was not found.", 404);
    await requireCampusPassenger(request, { entryId: trip.id, reference, email: trip.email });
    return ok(await campusFeedbackState(reference, trip.email), { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-feedback-write", { limit: 30, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before sending campusRide feedback.", 503);
    await ensureCampusRideTables();
    const body = await request.json().catch(() => ({})) as { reference?: string; kind?: string; rating?: number; comment?: string; category?: string; details?: string };
    const reference = String(body.reference || "").trim();
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing campusRide payment reference.", 400);
    const trip = await loadCampusRatedTrip(reference);
    if (!trip) throw new CampusEngineError("NOT_FOUND", "campusRide booking was not found.", 404);
    await requireCampusPassenger(request, { entryId: trip.id, reference, email: trip.email });
    const kind = String(body.kind || "RATING").trim().toUpperCase();
    if (kind === "RATING") {
      const rating = await rateCampusTrip({ reference, rating: body.rating, comment: body.comment, email: trip.email });
      return ok({ rating }, { headers: { "Cache-Control": "no-store" } }, request);
    }
    if (kind === "REPORT") {
      const dispute = await reportCampusTrip({ reference, category: body.category, details: body.details, email: trip.email });
      return ok({ report: { id: dispute.id, status: dispute.status, category: dispute.category } }, { status: 201, headers: { "Cache-Control": "no-store" } }, request);
    }
    throw new CampusEngineError("VALIDATION_ERROR", "Send a rating or a report.", 400);
  } catch (error) {
    return fail(error, request);
  }
}
