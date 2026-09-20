import { reconcilePendingCampusPayments } from "@/lib/campus-engine/reconcile";
import { reconcilePendingHostelPayments } from "@/lib/hostel-engine/reconcile";
import { dispatchPendingNotifications } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";

/**
 * Payment cron: re-verify stale campusRide payments against Paystack and
 * release slots held by expired checkouts. Every effect goes through the same
 * idempotent mark functions as the payment webhook, so a repeated or
 * overlapping run is safe. Never throws: a cron failure is logged and retried
 * on the next tick.
 *
 * Notifications are deliberately not dispatched here. Both jobs talk to Turso
 * one statement per subrequest, and sharing an invocation meant the outbox was
 * starved whenever the ride sweep grew. The queue delivers notifications now,
 * and `runNotificationSweep` is the retry net.
 */
export async function runCampusReconcile() {
  try {
    const result = await reconcilePendingCampusPayments();
    // Hostel holds ride the same trigger: two extra statements when there is
    // nothing stale, and a paid checkout that lost its webhook is caught here.
    const hostel = await reconcilePendingHostelPayments().catch(() => null);
    logEvent("info", "reconcile_run", {
      configured: result.configured,
      reconciled: result.reconciled,
      reviewed: result.reviewed,
      sweeps: result.sweeps.length,
      hostel: hostel ? { settled: hostel.settled, reviewed: hostel.reviewed, released: hostel.released, unverified: hostel.unverified } : "skipped",
    });
    return result;
  } catch (error) {
    logEvent("error", "reconcile_failed", { reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * Notification cron: drain due messages from the outbox.
 *
 * The failure reason is logged, never swallowed: a bare "failed" in the run log
 * once hid a subrequest-limit error behind an unreadable word.
 */
export async function runNotificationSweep(input: { limit?: number } = {}) {
  try {
    const result = await dispatchPendingNotifications({ limit: input.limit });
    logEvent("info", "notification_sweep", {
      configured: result.configured,
      considered: result.considered,
      sent: result.sent,
      failed: result.failed,
      pruned: result.pruned,
    });
    return result;
  } catch (error) {
    logEvent("error", "notification_dispatch_failed", {
      reason: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
    return null;
  }
}
