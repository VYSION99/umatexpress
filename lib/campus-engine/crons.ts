/**
 * Cron triggers for the Worker.
 *
 * The build declares these, and the Worker routes each one to a single job.
 * Two jobs in one invocation share one subrequest budget, and that is exactly
 * how notification delivery used to fail silently behind payment
 * reconciliation: the sweep ran out of subrequests before it reached the
 * outbox. One trigger, one job, one budget.
 */

/** Payment reconciliation: re-verify stale Paystack payments, release holds. */
export const CAMPUS_RECONCILE_CRON = "*/5 * * * *";

/**
 * Notification safety net. The queue delivers in milliseconds, so this sweep
 * only covers retries, rows queued while the queue was unavailable, and
 * deployments that run without the queue binding.
 *
 * The minutes are deliberately off the five-minute grid. Cloudflare collapses
 * two triggers that fall due at the same minute into one invocation, so a
 * quarter-hourly sweep would never run at all: every :00, :15, :30 and :45 also
 * belongs to the reconcile trigger, and only that one was ever delivered.
 */
export const NOTIFICATION_SWEEP_CRON = "2,17,32,47 * * * *";

export const WORKER_CRONS = [CAMPUS_RECONCILE_CRON, NOTIFICATION_SWEEP_CRON];
