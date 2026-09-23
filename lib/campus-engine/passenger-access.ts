import { CampusEngineError } from "@/lib/campus-engine/errors";
import { paymentTokenFromRequest, verifyPaymentToken } from "@/lib/payment-access";
import { studentOwnsEmail } from "@/lib/student-auth";
import { rowsToObjects, turso } from "@/lib/turso";

/**
 * The one door to a passenger's own booking.
 *
 * A booking belongs to two things at once, and either can open it: the one-hour
 * payment cookie a guest is handed at checkout, and the signed-in account the
 * receipt address belongs to. Both are checked here rather than in each route,
 * so cancelling, rating, reporting and checking a ticket cannot drift into four
 * slightly different notions of who owns a seat.
 */
export async function requireCampusPassenger(request: Request, input: { entryId: string; reference: string; email: string }) {
  const payment = rowsToObjects(await turso(
    "SELECT reference, access_token_hash FROM campus_payments WHERE queue_entry_id = ? ORDER BY created_at DESC LIMIT 1",
    [input.entryId],
  ))[0];
  // The cookie is keyed by the payment reference the checkout handed out, not
  // by the queue reference the ticket is shown under.
  const token = paymentTokenFromRequest(request, String(payment?.reference || input.reference));
  if (await verifyPaymentToken(token, payment?.access_token_hash)) return { via: "token" as const, email: input.email };
  if (await studentOwnsEmail(request, input.email)) return { via: "account" as const, email: String(input.email || "").trim().toLowerCase() };
  throw new CampusEngineError("FORBIDDEN", "campusRide booking access is not authorised.", 403);
}
