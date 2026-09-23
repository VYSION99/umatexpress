import { ensureCampusRideTables } from "@/lib/campus-ride";
import { releaseExpiredCampusHolds } from "@/lib/campus-engine/queue";
import { markCampusRidePaymentFailed, markCampusRidePaymentSuccessful } from "@/lib/campus-engine/rides";
import { runCampusRefundReconcile, runCampusUnmatchedRefundSweep } from "@/lib/campus-engine/refunds";
import { runCampusSeatWatchSweep } from "@/lib/campus-engine/watch";
import { verifyPaystackTransaction } from "@/lib/paystack";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
import { incrementMetric } from "@/lib/observability";

const DEFAULT_STALE_MINUTES = 5;
const MAX_LIMIT = 50;

/**
 * Re-verifies stale PENDING campusRide payments against Paystack and releases
 * any expired unpaid holds. Safe to run on a schedule: every effect it applies
 * goes through the same idempotent mark functions as the webhook.
 */
export async function reconcilePendingCampusPayments(input: { staleMinutes?: number; limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) {
    return { configured: false, reconciled: 0, reviewed: 0, sweeps: [] as Array<{ rideId: string; released: number }>, refunds: { settled: 0, failed: 0 }, unmatched: { refunded: 0, released: 0 }, watches: { notified: 0 } };
  }
  await ensureCampusRideTables();
  const staleMinutes = Math.max(1, Math.round(input.staleMinutes || DEFAULT_STALE_MINUTES));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(input.limit || 20)));
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();

  const pending = rowsToObjects(await turso(
    "SELECT reference FROM campus_payments WHERE provider = 'PAYSTACK' AND status = 'PENDING' AND created_at < ? ORDER BY created_at ASC LIMIT ?",
    [cutoff, limit],
  ));

  let reconciled = 0;
  let reviewed = 0;
  for (const row of pending) {
    const reference = String(row.reference || "");
    if (!reference) continue;
    try {
      const providerStatus = await verifyPaystackTransaction(reference);
      if (providerStatus.status === "SUCCESSFUL") {
        const result = await markCampusRidePaymentSuccessful(reference, Number(providerStatus.amount || 0), providerStatus.financialTransactionId || "", "", Number(providerStatus.fees || 0));
        if (result.status === "PAID_REVIEW") reviewed += 1;
        else reconciled += 1;
      } else if (providerStatus.status === "FAILED") {
        await markCampusRidePaymentFailed(reference, providerStatus.reason || "PAYSTACK_PAYMENT_FAILED", providerStatus.financialTransactionId || "");
        reconciled += 1;
      }
    } catch {
      // A provider hiccup must not fail the whole sweep; the next run retries.
    }
  }

  const stamp = new Date().toISOString();
  const rides = rowsToObjects(await turso("SELECT id FROM campus_rides WHERE status IN ('OPEN','PAUSED','FULL') LIMIT 200"));
  const sweeps: Array<{ rideId: string; released: number }> = [];
  for (const ride of rides) {
    const rideId = String(ride.id || "");
    if (!rideId) continue;
    const released = await releaseExpiredCampusHolds(turso, { rideId, nowIso: stamp });
    if (released > 0) {
      sweeps.push({ rideId, released });
      await incrementMetric("queue_expired_released", released);
    }
  }

  // Two money jobs ride the same tick: finished refunds the rail has since
  // settled, and paid seats no driver ever took. Both are idempotent, so a
  // repeated or overlapping run is harmless.
  const refunds = await runCampusRefundReconcile().catch(() => ({ settled: 0, failed: 0 }));
  const unmatched = await runCampusUnmatchedRefundSweep().catch(() => ({ refunded: 0, released: 0, amounts: 0 }));
  // The promise made to a student who found nothing live: the moment a seat
  // opens on the route they asked about, they hear about it. One query when
  // nobody has asked, and it settles each watch once.
  const watches = await runCampusSeatWatchSweep().catch(() => ({ notified: 0 }));

  return {
    configured: true, reconciled, reviewed, sweeps,
    refunds: { settled: refunds.settled, failed: refunds.failed },
    unmatched: { refunded: unmatched.refunded, released: unmatched.released },
    watches: { notified: watches.notified },
  };
}
