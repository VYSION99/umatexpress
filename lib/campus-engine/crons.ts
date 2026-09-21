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
 * Transfer settlement. A webhook is the fast path; this is what notices a
 * transfer whose webhook never arrived. It waits two minutes after sending
 * before it looks, so it cannot race the send it is checking on.
 */
export const PAYOUT_RECONCILE_CRON = "9,39 * * * *";

/**
 * The minutes of the hour a cron expression fires on, so the grids can be
 * compared rather than eyeballed.
 */
function minutesOf(expression: string) {
  const field = String(expression || "").split(" ")[0];
  const everyMinute = Array.from({ length: 60 }, (_, minute) => minute);
  if (field === "*") return everyMinute;
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return step > 0 ? everyMinute.filter((minute) => minute % step === 0) : [];
  }
  return field.split(",").map(Number).filter((minute) => Number.isInteger(minute) && minute >= 0 && minute < 60);
}

/**
 * Payout release, on every minute the other triggers leave free.
 *
 * Organizer money is only ever released once `release_after` has passed, so a
 * frequent trigger cannot pay anyone early — it is what makes the release
 * window real. That window is minutes now (a console setting, twenty by
 * default, zero for as-soon-as-settled), and a fifteen-minute trigger turned
 * twenty minutes into anything up to thirty-five.
 *
 * It cannot simply be `* * * * *`: two triggers due in the same minute collapse
 * into one invocation, and the job that loses is a job that never runs. So the
 * minutes the other three own are subtracted here rather than written out by
 * hand — a new trigger elsewhere cannot silently swallow this one. What is left
 * is a gap of at most three minutes, which the release window absorbs.
 *
 * The job is cheap when nothing is due: one query against the ledger, and the
 * Paystack balance is only read once somebody is actually payable.
 */
export const PAYOUT_RELEASE_CRON = `${
  Array.from({ length: 60 }, (_, minute) => minute)
    .filter((minute) => !new Set([
      ...minutesOf(CAMPUS_RECONCILE_CRON),
      ...minutesOf(NOTIFICATION_SWEEP_CRON),
      ...minutesOf(PAYOUT_RECONCILE_CRON),
    ]).has(minute))
    .join(",")
} * * * *`;

export const WORKER_CRONS = [CAMPUS_RECONCILE_CRON, NOTIFICATION_SWEEP_CRON, PAYOUT_RELEASE_CRON, PAYOUT_RECONCILE_CRON];
