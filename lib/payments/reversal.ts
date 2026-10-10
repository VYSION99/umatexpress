import { ensureFinanceSchema } from "@/lib/payments/schema";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

/** A provider reversal can mean a refund or chargeback. Preserve the original
 * accounting and inventory until staff match the reversal to that history. */
export async function flagPaymentReversal(reference: string, transactionId = "", reason = "PAYSTACK_PAYMENT_REVERSED") {
  if (!reference.trim()) throw new Error("A payment reference is required.");
  await ensureFinanceSchema();
  const stamp = new Date().toISOString();
  const tables = new Set(rowsToObjects(await turso("SELECT name FROM sqlite_master WHERE type='table'")).map(row => String(row.name)));
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  let expected: number | null = null;
  let currency = "GHS";

  if (tables.has("payments")) {
    const payment = rowsToObjects(await turso("SELECT booking_id,amount,currency FROM payments WHERE reference_id=? AND provider='PAYSTACK' LIMIT 1", [reference]))[0];
    if (payment) {
      expected = Number(payment.amount); currency = String(payment.currency);
      statements.push(
        { sql: "UPDATE payments SET status='REVERSAL_REVIEW',financial_transaction_id=?,failure_reason=?,updated_at=? WHERE reference_id=?", args: [transactionId, reason, stamp, reference] },
        { sql: "UPDATE bookings SET payment_status='REVERSAL_REVIEW',booking_status=CASE WHEN booking_status='CANCELLED' THEN booking_status ELSE 'PAYMENT_RECEIVED_REVIEW' END WHERE id=?", args: [String(payment.booking_id)] },
      );
      if (tables.has("organizer_payouts")) statements.push({
        sql: "UPDATE organizer_payouts SET status='FAILED',updated_at=? WHERE booking_id=? AND status='ACCRUED'",
        args: [stamp, String(payment.booking_id)],
      });
    }
  }
  if (tables.has("campus_payments")) {
    const payment = rowsToObjects(await turso("SELECT queue_entry_id,amount,currency FROM campus_payments WHERE reference=? AND provider='PAYSTACK' LIMIT 1", [reference]))[0];
    if (payment) {
      expected = Number(payment.amount); currency = String(payment.currency);
      statements.push(
        { sql: "UPDATE campus_payments SET status='REVERSAL_REVIEW',raw_response=?,updated_at=? WHERE reference=?", args: [reason, stamp, reference] },
        { sql: `UPDATE campus_queue_entries SET payment_status='REVERSAL_REVIEW',ticket_image_ready=0,
            queue_status=CASE WHEN queue_status IN ('BOARDED','COMPLETED','CANCELLED','CANCELLED_BY_STUDENT','EXPIRED','PAYMENT_FAILED') THEN queue_status ELSE 'PAYMENT_RECEIVED_REVIEW' END,
            updated_at=? WHERE id=?`, args: [stamp, String(payment.queue_entry_id)] },
      );
    }
  }
  if (tables.has("hostel_bookings")) {
    const booking = rowsToObjects(await turso("SELECT id,total_amount FROM hostel_bookings WHERE reference=? LIMIT 1", [reference]))[0];
    if (booking) {
      expected = Number(booking.total_amount);
      statements.push({
        // Reopening an expired/cancelled/refunded record may reacquire a bed
        // that now belongs to another student, so keep those records terminal.
        sql: "UPDATE hostel_bookings SET status='PAYMENT_REVIEW',provider='PAYSTACK',provider_reference=?,updated_at=? WHERE reference=? AND status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW')",
        args: [transactionId, stamp, reference],
      });
      if (tables.has("hostel_payouts")) statements.push({
        sql: "UPDATE hostel_payouts SET status='FAILED',updated_at=? WHERE booking_id=? AND status='ACCRUED'",
        args: [stamp, String(booking.id)],
      });
    }
  }
  if (tables.has("hostel_plugin_subscriptions")) {
    const subscription = rowsToObjects(await turso("SELECT id,checkout_amount FROM hostel_plugin_subscriptions WHERE reference=? LIMIT 1", [reference]))[0];
    if (subscription) {
      expected = Number(subscription.checkout_amount);
      statements.push({ sql: "UPDATE hostel_plugin_subscriptions SET status='CANCELLED',updated_at=? WHERE reference=? AND status IN ('PENDING_PAYMENT','ACTIVE')", args: [stamp, reference] });
    }
  }
  const handled = statements.length > 0;
  // The exception, fulfilment pause and payout hold commit together. Payouts
  // already sent remain reserved/released for manual investigation.
  await tursoTransaction([
    ...statements,
    { sql: "UPDATE payment_attempts SET state='REVIEW',updated_at=? WHERE reference=?", args: [stamp, reference] },
    { sql: `INSERT INTO finance_reconciliation(id,reference,kind,expected,observed,currency,status,details,created_at,updated_at)
        VALUES (?,?, 'CHARGE_REVERSAL',?,NULL,?,'REVIEW',?,?,?) ON CONFLICT(id) DO UPDATE SET
        status='REVIEW',details=excluded.details,updated_at=excluded.updated_at`,
      args: [`charge-reversal:${reference}`, reference, expected, currency, JSON.stringify({ transactionId, reason, handled, note: "Match to refund or chargeback before adjusting accounting. Review any payout already in flight." }), stamp, stamp] },
    { sql: "INSERT OR IGNORE INTO finance_audit(id,actor,action,target,reason,created_at) VALUES (?,'system:paystack','CHARGE_REVERSAL_REVIEW',?,?,?)",
      args: [`charge-reversal:${reference}`, reference, reason, stamp] },
  ]);
  return { handled, status: "REVERSAL_REVIEW" as const };
}
