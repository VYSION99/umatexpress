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

/**
 * Payout release. Organizer money is only ever released once `release_after`
 * has passed, so running more often than the daily schedule cannot pay anyone
 * early — it only drains a backlog sooner, and it keeps each run inside one
 * invocation's subrequest budget. The minutes are off every other trigger's
 * grid for the same collapse reason as the sweep above.
 */
export const PAYOUT_RELEASE_CRON = "7,22,37,52 * * * *";

/**
 * Transfer settlement. A webhook is the fast path; this is what notices a
 * transfer whose webhook never arrived. It waits two minutes after sending
 * before it looks, so it cannot race the send it is checking on.
 */
export const PAYOUT_RECONCILE_CRON = "9,39 * * * *";

export const WORKER_CRONS = [CAMPUS_RECONCILE_CRON, NOTIFICATION_SWEEP_CRON, PAYOUT_RELEASE_CRON, PAYOUT_RECONCILE_CRON];
