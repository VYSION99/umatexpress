import { ensureBookingsTable, ensurePaymentsTable, rowsToObjects, turso } from "@/lib/turso";
import { verifyPaystackWebhookSignature } from "@/lib/paystack";
import { markCampusRidePaymentFailed, markCampusRidePaymentSuccessful } from "@/lib/campus-engine/rides";
import { claimPaymentEvent, releasePaymentEvent } from "@/lib/payment-events";
import { incrementMetric, logEvent, requestIdFromRequest, withRequestId } from "@/lib/observability";

type PaystackWebhook = {
  event?: string;
  data?: {
    id?: number;
    reference?: string;
    amount?: number;
    status?: string;
    gateway_response?: string;
  };
};

function json(message: string, status = 200, requestId = "") {
  const response = Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
  return requestId ? withRequestId(response, requestId) : response;
}

async function markSuccessful(reference: string, amount: number, transactionId: string) {
  await ensureBookingsTable();
  await ensurePaymentsTable();

  const payment = rowsToObjects(await turso(
    "SELECT booking_id, amount, status FROM payments WHERE reference_id = ? AND provider = 'PAYSTACK' LIMIT 1",
    [reference],
  ))[0];
  if (!payment) return { handled: false, reason: "PAYMENT_NOT_FOUND" };

  const now = new Date().toISOString();
  const expectedAmount = Number(payment.amount || 0);
  if (Number(amount || 0) !== expectedAmount) {
    await turso(
      "UPDATE payments SET status = 'PAID_REVIEW', financial_transaction_id = ?, failure_reason = 'PAYSTACK_AMOUNT_MISMATCH', updated_at = ?, completed_at = ? WHERE reference_id = ?",
      [transactionId, now, now, reference],
    );
    await turso(
      "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'PAYMENT_RECEIVED_REVIEW' WHERE id = ?",
      [String(payment.booking_id)],
    );
    return { handled: true, status: "PAID_REVIEW" };
  }

  const claimed = await turso(
    "UPDATE seat_holds SET status = 'BOOKED' WHERE booking_id = ? AND status = 'HELD' AND expires_at >= ?",
    [String(payment.booking_id), now],
  );
  const alreadyBooked = Number(claimed.affected_row_count || 0) === 1 || rowsToObjects(await turso(
    "SELECT status FROM seat_holds WHERE booking_id = ? AND status = 'BOOKED' LIMIT 1",
    [String(payment.booking_id)],
  )).length === 1;

  if (!alreadyBooked) {
    await turso(
      "UPDATE payments SET status = 'PAID_REVIEW', financial_transaction_id = ?, failure_reason = 'SEAT_HOLD_EXPIRED', updated_at = ?, completed_at = ? WHERE reference_id = ?",
      [transactionId, now, now, reference],
    );
    await turso(
      "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'PAYMENT_RECEIVED_REVIEW' WHERE id = ?",
      [String(payment.booking_id)],
    );
    return { handled: true, status: "PAID_REVIEW" };
  }

  await turso(
    "UPDATE payments SET status = 'SUCCESSFUL', financial_transaction_id = ?, failure_reason = NULL, updated_at = ?, completed_at = ? WHERE reference_id = ?",
    [transactionId, now, now, reference],
  );
  await turso(
    "UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'CONFIRMED', confirmed_at = ? WHERE id = ?",
    [now, String(payment.booking_id)],
  );
  return { handled: true, status: "SUCCESSFUL" };
}

async function markFailed(reference: string, reason: string, transactionId: string) {
  await ensureBookingsTable();
  await ensurePaymentsTable();
  const payment = rowsToObjects(await turso(
    "SELECT booking_id FROM payments WHERE reference_id = ? AND provider = 'PAYSTACK' LIMIT 1",
    [reference],
  ))[0];
  if (!payment) return { handled: false, reason: "PAYMENT_NOT_FOUND" };

  const now = new Date().toISOString();
  await turso(
    "UPDATE payments SET status = 'FAILED', financial_transaction_id = ?, failure_reason = ?, updated_at = ?, completed_at = ? WHERE reference_id = ?",
    [transactionId, reason || "PAYSTACK_PAYMENT_FAILED", now, now, reference],
  );
  await turso("UPDATE bookings SET payment_status = 'FAILED', booking_status = 'PAYMENT_FAILED' WHERE id = ?", [String(payment.booking_id)]);
  await turso("DELETE FROM seat_holds WHERE booking_id = ? AND status = 'HELD'", [String(payment.booking_id)]);
  return { handled: true, status: "FAILED" };
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const noStore = (body: unknown, status = 200) => withRequestId(Response.json(body, { status, headers: { "Cache-Control": "no-store" } }), requestId);
  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");

  try {
    if (!await verifyPaystackWebhookSignature(rawBody, signature)) {
      return json("Invalid Paystack signature.", 401, requestId);
    }
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : "Paystack webhook is not configured." }, 503);
  }

  let event: PaystackWebhook;
  try {
    event = JSON.parse(rawBody) as PaystackWebhook;
  } catch {
    return json("Invalid webhook payload.", 400, requestId);
  }

  const reference = String(event.data?.reference || "").trim();
  if (!reference) return json("Webhook ignored: missing reference.", 200, requestId);

  const successful = event.event === "charge.success" && event.data?.status === "success";
  const failed = event.event === "charge.failed" || event.data?.status === "failed";
  if (!successful && !failed) return json("Webhook ignored: event is not actionable.", 200, requestId);

  // Record the event before acting on it. A duplicate delivery is acknowledged
  // and ignored so a replayed webhook can never double-apply a settlement.
  const eventId = event.data?.id ? String(event.data.id) : `${event.event || "unknown"}:${reference}`;
  try {
    if (!(await claimPaymentEvent("PAYSTACK", eventId, reference))) {
      await incrementMetric("webhook_duplicate");
      return json("Webhook ignored: event already processed.", 200, requestId);
    }
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : "Webhook could not be recorded." }, 503);
  }

  try {
    if (successful) {
      const amount = Number(event.data?.amount || 0);
      const transactionId = event.data?.id ? String(event.data.id) : "";
      const result = await markSuccessful(reference, amount, transactionId);
      if (!result.handled) {
        // The campus engine records its own settlement metric.
        return noStore(await markCampusRidePaymentSuccessful(reference, amount, transactionId, requestId));
      }
      await incrementMetric(result.status === "PAID_REVIEW" ? "payment_review" : "payment_success");
      return noStore(result);
    }

    const reason = event.data?.gateway_response || "PAYSTACK_PAYMENT_FAILED";
    const transactionId = event.data?.id ? String(event.data.id) : "";
    const result = await markFailed(reference, reason, transactionId);
    if (!result.handled) {
      return noStore(await markCampusRidePaymentFailed(reference, reason, transactionId, requestId));
    }
    await incrementMetric("payment_failed");
    return noStore(result);
  } catch (error) {
    // Let the provider retry a delivery we failed to apply.
    await incrementMetric("webhook_failed");
    logEvent("error", "webhook_failed", { requestId, reference, reason: error instanceof Error ? error.message : "unknown" });
    await releasePaymentEvent("PAYSTACK", eventId).catch(() => undefined);
    return noStore({ error: error instanceof Error ? error.message : "Webhook could not be processed." }, 500);
  }
}
