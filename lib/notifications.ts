import type { SqlExecutor } from "@/lib/campus-engine/queue";
import { ticketUrl } from "@/lib/campus-engine/notify-templates";
import { notificationQueue } from "@/lib/cloudflare-bindings";
import { looksLikeEmail, resendReady, sendEmail, type ResendConfig } from "@/lib/resend";
import { incrementMetric, logEvent } from "@/lib/observability";
import { envValue } from "@/lib/runtime-env";
import { ensureNotificationsTable, isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

const DEFAULT_BATCH = 20;
const MAX_ATTEMPTS = 3;
/** How long a worker may hold a claimed message before another may retry it. */
const LEASE_MS = 10 * 60_000;
const PENDING_RETENTION_MS = 7 * 86_400_000;
const SETTLED_RETENTION_MS = 30 * 86_400_000;
/** How many messages the in-app feed returns for one student. */
const FEED_LIMIT = 30;
/** Every queued passenger message leaves by email, so the column is a constant. */
const NOTIFICATION_CHANNEL = "email";

async function mailerConfig(): Promise<ResendConfig> {
  return {
    apiKey: await envValue("RESEND_API_KEY"),
    from: await envValue("RESEND_FROM"),
    replyTo: await envValue("RESEND_REPLY_TO"),
  };
}

/** "driver_accepted" → "Driver accepted", for rows queued before subjects existed. */
function humanizedTemplate(template: string) {
  const words = String(template || "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "UMaTeXPRESS update";
}

/** The email body: the same text the feed shows, plus the ticket link. */
export function emailBody(message: string, url: string) {
  return url ? `${message}\n\nTrack your ride: ${url}` : message;
}

/** Exponential-ish retry spacing: 30s, 2m, then capped at an hour. */
export function notificationBackoffMs(attempts: number) {
  const safe = Math.max(1, Math.round(attempts || 1));
  return Math.min(60 * 60_000, safe * safe * 30_000);
}

/** The queue payload. It only names a row: the outbox stays the source of truth. */
export type NotificationQueueMessage = { id: string; reference: string; template: string; queuedAt: string };

/**
 * Wakes the delivery queue for one queued message.
 *
 * A queue message is a nudge, never the record: the row in
 * `notification_outbox` is what gets delivered, atomically claimed, and
 * retried. That means a lost, duplicated or late message costs latency at
 * worst, and the five-minute cron sweep still picks up anything the queue did
 * not deliver.
 */
async function wakeNotificationQueue(message: NotificationQueueMessage) {
  const queue = await notificationQueue();
  if (!queue) return false;
  try {
    await queue.send(message, { contentType: "json" });
    return true;
  } catch (error) {
    logEvent("warn", "notification_queue_send_failed", {
      id: message.id,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return false;
  }
}

/**
 * Enqueues one passenger message.
 *
 * The row is both the email queue and the in-app notification the student sees,
 * so a missing mail provider still leaves the passenger with a readable record
 * of what happened. The unique `(reference, template)` index makes this
 * idempotent: a repeated driver action cannot send the same message twice.
 */
export async function queueNotification(exec: SqlExecutor, input: {
  recipient: string;
  template: string;
  subject: string;
  message: string;
  reference: string;
  nowIso: string;
}) {
  const recipient = String(input.recipient || "").trim();
  if (!recipient) return false;
  const id = crypto.randomUUID();
  const result = await exec(
    `INSERT INTO notification_outbox (id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',0,'',?,?)
     ON CONFLICT(reference, template) DO NOTHING`,
    [id, NOTIFICATION_CHANNEL, recipient, input.template, String(input.subject || ""), input.message, input.reference, input.nowIso, input.nowIso],
  );
  const inserted = Number(result?.affected_row_count ?? 0) > 0;
  if (inserted) {
    await wakeNotificationQueue({ id, reference: input.reference, template: input.template, queuedAt: input.nowIso });
  }
  return inserted;
}

/**
 * Takes exclusive ownership of one queued message. Only the worker whose
 * UPDATE affected a row may send it, so overlapping cron runs cannot deliver
 * the same email twice.
 */
export async function claimNotification(exec: SqlExecutor, input: { id: string; leaseUntil: string }) {
  const result = await exec(
    "UPDATE notification_outbox SET status = 'SENDING', attempts = attempts + 1, available_at = ? WHERE id = ? AND status = 'PENDING'",
    [input.leaseUntil, input.id],
  );
  return Number(result?.affected_row_count ?? 0) === 1;
}

/** Returns messages abandoned by a worker that died mid-send. */
export async function reclaimStaleNotifications(exec: SqlExecutor, input: { nowIso: string }) {
  const result = await exec("UPDATE notification_outbox SET status = 'PENDING' WHERE status = 'SENDING' AND available_at < ?", [input.nowIso]);
  return Number(result?.affected_row_count ?? 0);
}

/** Drops stale rows so the outbox cannot grow without bound. */
export async function pruneNotifications(exec: SqlExecutor, input: { now?: number } = {}) {
  const now = input.now ?? Date.now();
  const pending = await exec("DELETE FROM notification_outbox WHERE status = 'PENDING' AND created_at < ?", [new Date(now - PENDING_RETENTION_MS).toISOString()]);
  const settled = await exec("DELETE FROM notification_outbox WHERE status IN ('SENT','FAILED') AND created_at < ?", [new Date(now - SETTLED_RETENTION_MS).toISOString()]);
  return Number(pending?.affected_row_count ?? 0) + Number(settled?.affected_row_count ?? 0);
}

/**
 * The signed-in student's in-app feed, newest first. Rows are addressed by the
 * account email, so the feed needs no join back to the booking tables.
 */
export async function listNotifications(recipient: string, limit = FEED_LIMIT) {
  const address = String(recipient || "").trim();
  if (!address || !(await isTursoConfiguredRuntime())) return [];
  await ensureNotificationsTable();
  const rows = rowsToObjects(await turso(
    `SELECT id,template,subject,message,reference,created_at,read_at
     FROM notification_outbox
     WHERE recipient = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [address, Math.max(1, Math.min(FEED_LIMIT, Math.round(limit || FEED_LIMIT)))],
  ));
  return rows.map((row) => ({
    id: String(row.id || ""),
    template: String(row.template || ""),
    subject: String(row.subject || "") || humanizedTemplate(String(row.template || "")),
    message: String(row.message || ""),
    reference: String(row.reference || ""),
    createdAt: String(row.created_at || ""),
    read: Boolean(String(row.read_at || "")),
  }));
}

export type FeedNotification = Awaited<ReturnType<typeof listNotifications>>[number];

/**
 * Marks one message — or the whole feed — as read. Scoped by recipient, so a
 * student can never touch another account's feed.
 */
export async function markNotificationsRead(recipient: string, input: { id?: unknown; all?: unknown }) {
  const address = String(recipient || "").trim();
  if (!address || !(await isTursoConfiguredRuntime())) return 0;
  await ensureNotificationsTable();
  const nowIso = new Date().toISOString();
  if (input.all) {
    const result = await turso("UPDATE notification_outbox SET read_at = ? WHERE recipient = ? AND read_at IS NULL", [nowIso, address]);
    return Number(result?.affected_row_count ?? 0);
  }
  const id = String(input.id || "").trim();
  if (!id) return 0;
  const result = await turso("UPDATE notification_outbox SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL", [nowIso, id, address]);
  return Number(result?.affected_row_count ?? 0);
}

/** Delivery counts for admin reporting, including messages stuck in FAILED. */
export async function notificationQueueHealth() {
  const config = await mailerConfig();
  const empty = { configured: false, provider: "resend", providerReady: resendReady(config), pending: 0, sending: 0, sent: 0, failed: 0 };
  if (!(await isTursoConfiguredRuntime())) return empty;
  await ensureNotificationsTable();
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0 } as Record<string, number>;
  for (const row of rowsToObjects(await turso("SELECT status, COUNT(*) AS c FROM notification_outbox GROUP BY status"))) {
    const key = String(row.status || "").toLowerCase();
    if (key in counts) counts[key] = Number(row.c || 0);
  }
  return { ...empty, configured: true, ...counts };
}

/**
 * Delivers due messages through Resend.
 *
 * Each message is claimed with an atomic UPDATE before sending, so overlapping
 * cron runs cannot deliver the same email twice. Retention pruning runs even
 * when the provider is unconfigured, so a dormant outbox stays bounded, and
 * rows left over from the retired SMS providers (no `@` in the recipient) are
 * simply never attempted.
 */
export async function dispatchPendingNotifications(input: { limit?: number; ids?: string[] } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { configured: false, sent: 0, failed: 0, considered: 0, pruned: 0 };
  await ensureNotificationsTable();
  await reclaimStaleNotifications(turso, { nowIso: new Date().toISOString() });
  // A queue-driven dispatch names its rows, so it skips the retention scan; the
  // cron sweep owns pruning.
  const ids = (input.ids ?? []).map((id) => String(id || "").trim()).filter(Boolean).slice(0, 100);
  const pruned = ids.length ? 0 : await pruneNotifications(turso);

  const config = await mailerConfig();
  if (!resendReady(config)) return { configured: false, sent: 0, failed: 0, considered: 0, pruned };

  const limit = Math.max(1, Math.min(100, Math.round(input.limit || ids.length || DEFAULT_BATCH)));
  const idFilter = ids.length ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
  const due = rowsToObjects(await turso(
    `SELECT id,recipient,subject,template,message,reference FROM notification_outbox WHERE status = 'PENDING' AND available_at <= ? AND recipient LIKE '%@%'${idFilter} ORDER BY created_at ASC LIMIT ?`,
    [new Date().toISOString(), ...ids, limit],
  ));
  // Only the email carries the ticket link: the feed shows the message alone.
  const appUrl = await envValue("CAMPUS_APP_URL");
  const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const id = String(row.id);
    const to = String(row.recipient || "").trim();
    if (!looksLikeEmail(to)) continue;
    // Another worker already owns this message; leave it to them.
    if (!(await claimNotification(turso, { id, leaseUntil }))) continue;
    const attempts = Number(row.attempts || 0) + 1;
    try {
      const result = await sendEmail({
        config,
        to,
        subject: String(row.subject || "") || humanizedTemplate(String(row.template || "")),
        text: emailBody(String(row.message || ""), ticketUrl(String(row.reference || ""), appUrl)),
      });
      if (!result.ok) throw new Error(result.error || "delivery failed");
      await turso("UPDATE notification_outbox SET status = 'SENT', sent_at = ?, last_error = '' WHERE id = ? AND status = 'SENDING'", [new Date().toISOString(), id]);
      sent += 1;
      await incrementMetric("notification_sent");
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : "delivery failed";
      const exhausted = attempts >= MAX_ATTEMPTS;
      await turso(
        "UPDATE notification_outbox SET status = ?, last_error = ?, available_at = ? WHERE id = ? AND status = 'SENDING'",
        [exhausted ? "FAILED" : "PENDING", reason, new Date(Date.now() + notificationBackoffMs(attempts)).toISOString(), id],
      );
      failed += 1;
      await incrementMetric("notification_failed");
    }
  }

  if (due.length) logEvent("info", "notification_dispatch", { considered: due.length, sent, failed, pruned });
  return { configured: true, sent, failed, considered: due.length, pruned };
}
