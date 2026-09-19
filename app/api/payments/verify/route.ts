import { ensureBookingsTable, ensurePaymentsTable, rowsToObjects, turso } from "@/lib/turso";
import { getPaymentStatus } from "@/lib/mtn-momo";
import { verifyPaystackTransaction } from "@/lib/paystack";
import { hashPaymentToken, paymentTokenFromRequest } from "@/lib/payment-access";
import { getDynamicTrip } from "@/lib/dynamic-trips";
import { accrueForBooking } from "@/lib/organizer-payouts";
import { notifyVacationBookingConfirmed } from "@/lib/vacation-notify";
import { requestIdFromRequest, withRequestId } from "@/lib/observability";

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Turso") || message.includes("valid Turso credentials")) return 503;
  if (message.includes("MTN MoMo is not configured")) return 503;
  if (message.includes("Paystack is not configured")) return 503;
  if (message.includes("MTN token request failed") || message.includes("MTN payment status request failed")) return 502;
  if (message.includes("Paystack verify failed")) return 502;
  return 500;
}

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(Response.json(body, init), requestId);
  const reference = new URL(request.url).searchParams.get("reference");
  if (!reference) return respond({ error: "Missing payment reference." }, { status: 400 });

  try {
    await ensureBookingsTable();
    await ensurePaymentsTable();

    const payment = rowsToObjects(await turso(
      "SELECT id, booking_id, provider, reference_id, amount, status, access_token_hash FROM payments WHERE reference_id = ? LIMIT 1",
      [reference],
    ))[0];
    if (!payment) return respond({ error: "Payment was not found." }, { status: 404 });

    const token = paymentTokenFromRequest(request, reference);
    if (!token || !payment.access_token_hash || await hashPaymentToken(token) !== String(payment.access_token_hash)) {
      return respond({ error: "Payment access is not authorised." }, { status: 403 });
    }

    let status = String(payment.status || "PENDING").toUpperCase();
    if (status !== "SUCCESSFUL" && status !== "FAILED" && status !== "PAID_REVIEW") {
      const provider = String(payment.provider || "MTN_MOMO").toUpperCase();
      const providerStatus = provider === "PAYSTACK" ? await verifyPaystackTransaction(reference) : await getPaymentStatus(reference);
      status = String(providerStatus.status || "PENDING").toUpperCase();
      const now = new Date().toISOString();

      if (status === "SUCCESSFUL") {
        if (provider === "PAYSTACK" && Number(providerStatus.amount || 0) !== Number(payment.amount || 0)) {
          status = "PAID_REVIEW";
          await turso(
            "UPDATE payments SET status = 'PAID_REVIEW', failure_reason = 'PAYSTACK_AMOUNT_MISMATCH', updated_at = ?, completed_at = ? WHERE reference_id = ?",
            [now, now, reference],
          );
          await turso(
            "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'PAYMENT_RECEIVED_REVIEW' WHERE id = ?",
            [String(payment.booking_id)],
          );
        } else {
        const claimed = await turso(
          "UPDATE seat_holds SET status = 'BOOKED' WHERE booking_id = ? AND status = 'HELD' AND expires_at >= ?",
          [String(payment.booking_id), now],
        );
        const alreadyBooked = Number(claimed.affected_row_count || 0) === 1 || rowsToObjects(await turso(
          "SELECT status FROM seat_holds WHERE booking_id = ? AND status = 'BOOKED' LIMIT 1",
          [String(payment.booking_id)],
        )).length === 1;
        if (!alreadyBooked) {
          status = "PAID_REVIEW";
          await turso(
            "UPDATE payments SET status = 'PAID_REVIEW', financial_transaction_id = ?, failure_reason = 'SEAT_HOLD_EXPIRED', updated_at = ?, completed_at = ? WHERE reference_id = ?",
            [providerStatus.financialTransactionId || "", now, now, reference],
          );
          await turso(
            "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'PAYMENT_RECEIVED_REVIEW' WHERE id = ?",
            [String(payment.booking_id)],
          );
        } else {
          await turso(
            "UPDATE payments SET status = 'SUCCESSFUL', financial_transaction_id = ?, failure_reason = NULL, updated_at = ?, completed_at = ? WHERE reference_id = ?",
            [providerStatus.financialTransactionId || "", now, now, reference],
          );
          await turso(
            "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'CONFIRMED', confirmed_at = ? WHERE id = ?",
            [now, String(payment.booking_id)],
          );
          // The ledger write must never turn a successful payment into an
          // error, so it logs its own failure and the admin backfill catches it.
          await accrueForBooking(String(payment.booking_id));
          // Same rule for the passenger's confirmation: the outbox row is
          // idempotent and failure is logged, never surfaced as a payment error.
          await notifyVacationBookingConfirmed(String(payment.booking_id));
        }
        }
      } else if (status === "FAILED") {
        await turso(
          "UPDATE payments SET status = 'FAILED', failure_reason = ?, updated_at = ?, completed_at = ? WHERE reference_id = ?",
          [providerStatus.reason || "PAYMENT_FAILED", now, now, reference],
        );
        await turso("UPDATE bookings SET payment_status = 'FAILED', booking_status = 'PAYMENT_FAILED' WHERE id = ?", [String(payment.booking_id)]);
        await turso("DELETE FROM seat_holds WHERE booking_id = ? AND status = 'HELD'", [String(payment.booking_id)]);
      } else {
        await turso("UPDATE payments SET status = 'PENDING', updated_at = ? WHERE reference_id = ?", [now, reference]);
      }
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
          route_from: trip?.from || "UMaT Main Campus",
          route_to: trip?.to || "Accra",
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
