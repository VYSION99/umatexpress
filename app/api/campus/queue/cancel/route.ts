import { cancelCampusRideBooking, loadRefundableEntry } from "@/lib/campus-engine/refunds";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { requireCampusPassenger } from "@/lib/campus-engine/passenger-access";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { ensureCampusRideTables } from "@/lib/campus-ride";
import { isTursoConfiguredRuntime } from "@/lib/turso";

/**
 * A passenger giving up their seat.
 *
 * Authorised exactly like the ticket itself: the one-hour payment cookie a
 * guest is given at checkout, or the signed-in account the booking was made
 * under. Cancelling is free while nobody has taken the seat, and the refund is
 * recorded here but sent by the refund desk or the sweep — never by this route,
 * so a passenger can never move money with a tap.
 */
export async function POST(request: Request) {
  try {
    // Cancelling frees a seat and can open a refund, so the limit is tighter
    // than a status read.
    const limited = await rateLimit(request, "campus-queue-cancel", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before cancelling campusRide bookings.", 503);
    await ensureCampusRideTables();
    const body = await request.json().catch(() => ({})) as { reference?: string; reason?: string };
    const reference = String(body.reference || "").trim();
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing campusRide payment reference.", 400);

    const entry = await loadRefundableEntry(reference);
    if (!entry) throw new CampusEngineError("NOT_FOUND", "campusRide booking was not found.", 404);
    await requireCampusPassenger(request, { entryId: entry.id, reference, email: entry.email });

    const result = await cancelCampusRideBooking(reference, body.reason, entry.email || "guest");
    return ok({
      cancelled: result.cancelled,
      status: result.status,
      cancellation: result.quote,
      refund: result.refund ? { id: result.refund.id, amount: result.refund.amount, status: result.refund.status } : null,
    }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
