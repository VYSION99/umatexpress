import { ensureBookingsTable, ensurePaymentsTable, rowsToObjects, turso } from "@/lib/turso";
import { verifyPaystackTransaction } from "@/lib/paystack";
import { paymentTokenFromRequest, verifyPaymentToken } from "@/lib/payment-access";
import { getDynamicTrip } from "@/lib/dynamic-trips";
import { markSuccessful, markFailed } from "@/lib/payments/vacation";
import { studentOwnsEmail } from "@/lib/student-auth";
import { requestIdFromRequest, withRequestId } from "@/lib/observability";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Turso") || message.includes("valid Turso credentials")) return 503;
  if (message.includes("Paystack is not configured")) return 503;
  if (message.includes("Paystack verify failed")) return 502;
  return 500;
}

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(Response.json(body, init), requestId);
  // Each attempt costs a Paystack verify call and can settle a booking, so the
  // poll is metered even though the reference is unguessable.
  const limited = await rateLimit(request, "payment-verify-read", { limit: 120, windowMs: 10 * 60_000 });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  const reference = new URL(request.url).searchParams.get("reference");
  if (!reference) return respond({ error: "Missing payment reference." }, { status: 400 });

  try {
    await ensureBookingsTable();
    await ensurePaymentsTable();

    const payment = rowsToObjects(await turso(
      "SELECT id, booking_id, provider, reference_id, amount, currency, status, access_token_hash FROM payments WHERE reference_id = ? LIMIT 1",
      [reference],
    ))[0];
    if (!payment) return respond({ error: "Payment was not found." }, { status: 404 });

    const token = paymentTokenFromRequest(request, reference);
    const authorised = await verifyPaymentToken(token, payment.access_token_hash);
    // The token is the guest's key: minted at checkout and good for an hour.
    // A student who signed in keeps access to their own booking without it,
    // because the booking was made under their account's address — that is what
    // lets an emailed ticket link work on another device, or next week. The
    // lookup only runs when the token is missing or stale, so the paid path
    // stays one query deep.
    if (!authorised) {
      const owner = rowsToObjects(await turso("SELECT email FROM bookings WHERE id = ? LIMIT 1", [String(payment.booking_id)]))[0];
      if (!(await studentOwnsEmail(request, owner?.email))) {
        return respond({ error: "Payment access is not authorised." }, { status: 403 });
      }
    }

    let status = String(payment.status || "PENDING").toUpperCase();
    if (status !== "SUCCESSFUL" && status !== "FAILED" && status !== "PAID_REVIEW") {
      const provider = String(payment.provider || "PAYSTACK").toUpperCase();
      if (provider !== "PAYSTACK") return respond({error:"This payment provider is no longer supported. Contact support."},{status:409});
      const providerStatus = await verifyPaystackTransaction(reference);
      status = String(providerStatus.status || "PENDING").toUpperCase();
      if (status === "SUCCESSFUL") {
        const settled = await markSuccessful(reference,
          Number(providerStatus.amount || 0),
          String(providerStatus.currency || ""), providerStatus.financialTransactionId || "", provider);
        status = settled.status || status;
      } else if (status === "FAILED") {
        const settled = await markFailed(reference, providerStatus.reason || "PAYMENT_FAILED",
          providerStatus.financialTransactionId || "", provider);
        status = settled.status || status;
      }
      // Pending observations must never overwrite a concurrent success.

    }

    let ticket;
    if (status === "SUCCESSFUL") {
      ticket = rowsToObjects(await turso(
        "SELECT reference, passenger_name, seat, trip_id, travel_date, departure_time, amount FROM bookings WHERE id = ? AND booking_status = 'CONFIRMED' LIMIT 1",
        [String(payment.booking_id)],
      ))[0];
      if (ticket) {
        // A ticket that was already sold must still resolve even if the trip has
        // since been archived or pulled from sale.
        const trip = await getDynamicTrip(String(ticket.trip_id), { includeArchived: true, approvedOnly: false });
        ticket = {
          ...ticket,
          route_from: trip?.from || "",
          route_to: trip?.to || "",
          arrival_time: trip?.arrival || "",
          coach_type: trip?.coachType || "VIP Coach",
          trip_title: trip?.title || "UMaTeXPRESS",
        };
      }
    }

    return respond({ paid: status === "SUCCESSFUL", status, reference, ticket }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : "Payment verification failed." }, { status: errorStatus(error) });
  }
}
