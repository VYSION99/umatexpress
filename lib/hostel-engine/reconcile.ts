import { activatePluginSubscription, cancelPluginSubscription, ensureHostelPluginTables, releaseExpiredPluginHolds } from "@/lib/hostel-engine/plugins";
import { expireHostelBooking, failHostelBooking, releaseExpiredHostelHolds, settleHostelBooking } from "@/lib/hostel-engine/residency";
import { incrementMetric, logEvent } from "@/lib/observability";
import { verifyPaystackTransaction } from "@/lib/paystack";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * The hostel half of the five-minute reconcile.
 *
 * The webhook is the fast path; this is what catches a checkout whose callback
 * and webhook both went missing. Every stale pending payment is re-verified with
 * Paystack before anything is released, and a hold is only given back after the
 * provider says it was never paid — which is why the blunt release in the
 * residency engine keeps a grace window of its own.
 */

const DEFAULT_STALE_MINUTES = 5;
const MAX_LIMIT = 25;

export async function reconcilePendingHostelPayments(input: { staleMinutes?: number; limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) {
    return { configured: false, settled: 0, reviewed: 0, released: 0, unverified: 0 };
  }
  await ensureHostelPluginTables();
  const staleMinutes = Math.max(1, Math.round(input.staleMinutes || DEFAULT_STALE_MINUTES));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(input.limit || 10)));
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();

  let settled = 0;
  let reviewed = 0;
  let released = 0;
  let unverified = 0;

  const bookings = rowsToObjects(await turso(
    "SELECT reference FROM hostel_bookings WHERE status = 'PENDING_PAYMENT' AND created_at < ? ORDER BY created_at ASC LIMIT ?",
    [cutoff, limit],
  ));
  const subscriptions = rowsToObjects(await turso(
    "SELECT reference FROM hostel_plugin_subscriptions WHERE status = 'PENDING_PAYMENT' AND created_at < ? ORDER BY created_at ASC LIMIT ?",
    [cutoff, limit],
  ));

  for (const row of bookings) {
    const reference = String(row.reference || "");
    if (!reference) continue;
    try {
      const payment = await verifyPaystackTransaction(reference);
      if (payment.status === "SUCCESSFUL") {
        const result = await settleHostelBooking({ reference, amount: payment.amount, transactionId: payment.financialTransactionId, provider: "PAYSTACK", source: "reconcile" });
        if (result.status === "PAYMENT_REVIEW") reviewed += 1;
        else settled += 1;
      } else if (payment.status === "FAILED") {
        await failHostelBooking(reference);
        released += 1;
      } else {
        // The provider was reached and says this checkout was never paid.
        await expireHostelBooking(reference);
        released += 1;
      }
    } catch {
      // A provider hiccup must not fail the sweep; the next run retries, and
      // the grace window keeps the bed held until then.
      unverified += 1;
    }
  }

  for (const row of subscriptions) {
    const reference = String(row.reference || "");
    if (!reference) continue;
    try {
      const payment = await verifyPaystackTransaction(reference);
      if (payment.status === "SUCCESSFUL") {
        await activatePluginSubscription({ reference, amount: payment.amount, source: "reconcile" });
        settled += 1;
      } else if (payment.status === "FAILED" || payment.status === "PENDING") {
        await cancelPluginSubscription(reference);
        released += 1;
      }
    } catch {
      unverified += 1;
    }
  }

  // The blunt release only runs when every check answered: if Paystack could not
  // be reached, the beds stay held rather than risk a paid student losing one.
  if (unverified === 0) {
    released += await releaseExpiredHostelHolds();
    released += await releaseExpiredPluginHolds();
  }

  if (settled || reviewed || released) {
    await incrementMetric("hostel_reconcile_swept");
    logEvent("info", "hostel_reconcile", { settled, reviewed, released, unverified, bookings: bookings.length, subscriptions: subscriptions.length });
  }
  return { configured: true, settled, reviewed, released, unverified };
}
