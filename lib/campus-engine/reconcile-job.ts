import { reconcilePendingCampusPayments } from "@/lib/campus-engine/reconcile";
import { dispatchPendingNotifications } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";

/**
 * Cron maintenance entry point: re-verify stale campusRide payments against
 * Paystack and release slots held by expired checkouts. Every effect goes
 * through the same idempotent mark functions as the payment webhook, so a
 * repeated or overlapping run is safe. Never throws: a cron failure is logged
 * and retried on the next tick.
 */
export async function runCampusReconcile() {
  try {
    const result = await reconcilePendingCampusPayments();
    // A notification failure must not hide the payment reconciliation result.
    const notifications = await dispatchPendingNotifications().catch(() => null);
    logEvent("info", "reconcile_run", {
      configured: result.configured,
      reconciled: result.reconciled,
      reviewed: result.reviewed,
      sweeps: result.sweeps.length,
      notifications: notifications ? (notifications.configured ? `${notifications.sent}/${notifications.considered}` : "unconfigured") : "failed",
    });
    return result;
  } catch (error) {
    logEvent("error", "reconcile_failed", { reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}
