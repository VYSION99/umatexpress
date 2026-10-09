import { ensureBookingsTable, ensurePaymentsTable, rowsToObjects, turso, tursoTransaction } from "@/lib/turso";
import { accrueForBooking } from "@/lib/organizer-payouts";
import { notifyVacationBookingConfirmed } from "@/lib/vacation-notify";

export async function markSuccessful(reference: string, amount: number, currency: string, transactionId: string, provider = "PAYSTACK") {
  await ensureBookingsTable();
  await ensurePaymentsTable();

  const payment = rowsToObjects(await turso(
    "SELECT booking_id, amount, currency, status FROM payments WHERE reference_id = ? AND provider = ? LIMIT 1",
    [reference, provider],
  ))[0];
  if (!payment) return { handled: false, reason: "PAYMENT_NOT_FOUND" };

  if (payment.status === "SUCCESSFUL") {
    await accrueForBooking(String(payment.booking_id));
    await notifyVacationBookingConfirmed(String(payment.booking_id));
    return { handled: true, status: "SUCCESSFUL" };
  }
  if (payment.status === "PAID_REVIEW") return { handled: true, status: "PAID_REVIEW" };
  const now = new Date().toISOString();
  const expectedAmount = Number(payment.amount || 0);
  // Only a reported currency can mismatch; an absent one says nothing, and
  // treating it as wrong parks a paid booking in review.
  const providerCurrency = String(currency || "").toUpperCase();
  const currencyMismatch = providerCurrency !== ""
    && providerCurrency !== String(payment.currency || "").toUpperCase();
  if (Number(amount || 0) !== expectedAmount || currencyMismatch) {
    await tursoTransaction([
      { sql: "UPDATE payments SET status = 'PAID_REVIEW', financial_transaction_id = ?, failure_reason = ?, updated_at = ?, completed_at = ? WHERE reference_id = ? AND status NOT IN ('SUCCESSFUL','PAID_REVIEW')",
        args: [transactionId, currencyMismatch ? "PAYSTACK_CURRENCY_MISMATCH" : "PAYSTACK_AMOUNT_MISMATCH", now, now, reference] },
      { sql: "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'PAYMENT_RECEIVED_REVIEW' WHERE id = ? AND booking_status NOT IN ('CANCELLED','CONFIRMED')",
        args: [String(payment.booking_id)] },
    ]);
    return { handled: true, status: "PAID_REVIEW" };
  }

  await tursoTransaction([
    { sql: "UPDATE seat_holds SET status = 'BOOKED' WHERE booking_id = ? AND status = 'HELD' AND expires_at >= ? AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND booking_status NOT IN ('CANCELLED','PAYMENT_RECEIVED_REVIEW'))",
      args: [String(payment.booking_id), now, String(payment.booking_id)] },
    { sql: `UPDATE payments SET status = CASE WHEN EXISTS (
        SELECT 1 FROM seat_holds h JOIN bookings b ON b.id=h.booking_id
        WHERE h.booking_id=payments.booking_id AND h.status='BOOKED' AND b.booking_status!='CANCELLED'
      ) THEN 'SUCCESSFUL' ELSE 'PAID_REVIEW' END,
      financial_transaction_id=?, updated_at=?, completed_at=?
      WHERE reference_id=? AND status NOT IN ('SUCCESSFUL','PAID_REVIEW')`,
      args: [transactionId, now, now, reference] },
    { sql: "UPDATE payments SET failure_reason = CASE WHEN status='PAID_REVIEW' THEN 'SEAT_HOLD_EXPIRED_OR_CANCELLED' ELSE NULL END WHERE reference_id=?",
      args: [reference] },
    { sql: `UPDATE bookings SET payment_status='SUCCESSFUL',
      booking_status=CASE WHEN (SELECT status FROM payments WHERE reference_id=?)='SUCCESSFUL'
        THEN 'CONFIRMED' ELSE 'PAYMENT_RECEIVED_REVIEW' END,
      confirmed_at=CASE WHEN (SELECT status FROM payments WHERE reference_id=?)='SUCCESSFUL' THEN ? ELSE confirmed_at END
      WHERE id=? AND booking_status!='CANCELLED'`, args: [reference, reference, now, String(payment.booking_id)] },
  ]);
  const settled = rowsToObjects(await turso("SELECT status FROM payments WHERE reference_id=?", [reference]))[0];
  if (settled?.status !== "SUCCESSFUL") return { handled: true, status: String(settled?.status || "PAID_REVIEW") };
  // Verify and the webhook can both confirm the same booking; the ledger's
  // unique booking index makes the second accrual a no-op.
  await accrueForBooking(String(payment.booking_id));
  // The outbox is deduped the same way, so whichever path confirms first
  // sends the one confirmation the passenger sees.
  await notifyVacationBookingConfirmed(String(payment.booking_id));
  return { handled: true, status: "SUCCESSFUL" };
}
export async function markFailed(reference: string, reason: string, transactionId: string, provider = "PAYSTACK") {
  await ensureBookingsTable();
  await ensurePaymentsTable();
  const payment = rowsToObjects(await turso(
    "SELECT booking_id, status FROM payments WHERE reference_id = ? AND provider = ? LIMIT 1",
    [reference, provider],
  ))[0];
  if (!payment) return { handled: false, reason: "PAYMENT_NOT_FOUND" };

  if (["SUCCESSFUL", "PAID_REVIEW"].includes(String(payment.status))) return { handled: true, status: String(payment.status) };
  const now = new Date().toISOString();
  await tursoTransaction([
    { sql: "UPDATE payments SET status = 'FAILED', financial_transaction_id = ?, failure_reason = ?, updated_at = ?, completed_at = ? WHERE reference_id = ? AND status NOT IN ('SUCCESSFUL','PAID_REVIEW')",
      args: [transactionId, reason || "PAYMENT_FAILED", now, now, reference] },
    { sql: "UPDATE bookings SET payment_status='FAILED', booking_status='PAYMENT_FAILED' WHERE id=? AND booking_status NOT IN ('CONFIRMED','PAYMENT_RECEIVED_REVIEW','CANCELLED') AND EXISTS (SELECT 1 FROM payments WHERE reference_id=? AND status='FAILED')",
      args: [String(payment.booking_id), reference] },
    { sql: "DELETE FROM seat_holds WHERE booking_id=? AND status='HELD' AND EXISTS (SELECT 1 FROM payments WHERE reference_id=? AND status='FAILED')",
      args: [String(payment.booking_id), reference] },
  ]);
  const current = rowsToObjects(await turso("SELECT status FROM payments WHERE reference_id=?", [reference]))[0];
  return { handled: true, status: String(current?.status || "FAILED") };
}
