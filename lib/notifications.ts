import type { SqlExecutor } from "@/lib/campus-engine/queue";
import { parseConsoleHosts } from "@/lib/console-hosts";
import { notificationAction } from "@/lib/notification-destinations";
import { renderNotificationEmail } from "@/lib/email-template";
import { notificationQueue } from "@/lib/cloudflare-bindings";
import { looksLikeEmail, resendReady, sendEmail, type ResendConfig } from "@/lib/resend";
import { looksLikePhone, sailupReady, sendSms, type SailupConfig } from "@/lib/sailup";
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
/**
 * The channels a row may leave by. Email is the default and carries the ticket
 * link; SMS is chosen per message, because a text costs money by the segment
 * and reaches a handset that may not be the passenger's own.
 */
export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
const DEFAULT_CHANNEL: NotificationChannel = "email";
/** Three segments is the ceiling: past that, a message is cheaper as a call. */
const SMS_MAX_CHARACTERS = 480;

async function mailerConfig(): Promise<ResendConfig> {
  return {
    apiKey: await envValue("RESEND_API_KEY"),
    from: await envValue("RESEND_FROM"),
    replyTo: await envValue("RESEND_REPLY_TO"),
  };
}

async function textConfig(): Promise<SailupConfig> {
  return {
    apiKey: await envValue("SAILUP_API_KEY"),
    senderId: await envValue("SAILUP_SENDER_ID"),
    baseUrl: await envValue("SAILUP_BASE_URL"),
  };
}

/** "driver_accepted" → "Driver accepted", for rows queued before subjects existed. */
function humanizedTemplate(template: string) {
  const words = String(template || "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "UMaTeXPRESS update";
}

/** The email body: the same text the feed shows, plus the ticket link. */
export function emailBody(message: string, url: string, cta = "Track your ride") {
  return url ? `${message}\n\n${cta}: ${url}` : message;
}

/**
 * The SMS body: the message and the bare link, without the spoken
 * call-to-action. A text is billed per 160 characters, so "Track your ride: "
 * would be charged on every message to say what the URL already says. Anything
 * past the ceiling is cut with an ellipsis rather than sent as a fourth and
 * fifth segment.
 */
export function smsBody(message: string, url: string, max = SMS_MAX_CHARACTERS) {
  const text = url ? `${message}\n${url}` : message;
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
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
 * worst, and the notification sweep still picks up anything the queue did
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
 * The row is both the delivery queue (mail or text) and the in-app notification
 * the student sees, so a missing provider still leaves the passenger with a
 * readable record of what happened. The unique `(reference, template)` index
 * makes this idempotent: a repeated driver action cannot send the same message
 * twice.
 */
export async function queueNotification(exec: SqlExecutor, input: {
  recipient: string;
  template: string;
  subject: string;
  message: string;
  reference: string;
  nowIso: string;
  /** Defaults to email; pass "sms" to reach a handset instead of an inbox. */
  channel?: NotificationChannel;
  /** Email-only proof or other private delivery, never shown in the feed. */
  sensitive?: boolean;
  /** Time-limited messages cannot be sent after their proof expires. */
  expiresAt?: string;
}) {
  const recipient = String(input.recipient || "").trim();
  if (!recipient) return false;
  const id = crypto.randomUUID();
  const result = await exec(
    `INSERT INTO notification_outbox (id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at,sensitive,expires_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',0,'',?,?,?,?)
     ON CONFLICT(reference, template) DO NOTHING`,
    [id, input.channel === "sms" ? "sms" : DEFAULT_CHANNEL, recipient, input.template, String(input.subject || ""), input.message, input.reference, input.nowIso, input.nowIso, input.sensitive ? 1 : 0, input.expiresAt || ""],
  );
  const inserted = Number(result?.affected_row_count ?? 0) > 0;
  if (inserted) {
    await wakeNotificationQueue({ id, reference: input.reference, template: input.template, queuedAt: input.nowIso });
  }
  return inserted;
}

/** Security mail is email-only and has no in-app action or secret payload. */
export async function notifyPasswordChanged(recipient: string) {
  try {
    await ensureNotificationsTable();
    return await queueNotification(turso, {
      recipient,
      template: "auth_password_changed",
      subject: "Your UMaTeXPRESS password was changed",
      message: "Your account password was changed. If this was not you, use account recovery immediately and contact support.",
      reference: "security:" + crypto.randomUUID(),
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    logEvent("error", "password_change_notice_failed", { reason: error instanceof Error ? error.message : "unknown" });
    return false;
  }
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
  const settled = await exec("DELETE FROM notification_outbox WHERE status IN ('SENT','FAILED') AND COALESCE(sent_at,available_at) < ?", [new Date(now - SETTLED_RETENTION_MS).toISOString()]);
  const expired = await exec("UPDATE notification_outbox SET status='FAILED',last_error='Message expired',available_at=?,subject='Authentication message',message='',sensitive=1 WHERE status='PENDING' AND ((expires_at<>'' AND expires_at<=?) OR (template='auth_login_code' AND created_at<?) OR (template='auth_password_reset' AND created_at<?))", [new Date(now).toISOString(), new Date(now).toISOString(), new Date(now - 10 * 60_000).toISOString(), new Date(now - 30 * 60_000).toISOString()]);
  const pending = await exec("UPDATE notification_outbox SET status = 'FAILED', last_error = 'Delivery window exceeded', available_at = ?, subject = CASE WHEN sensitive=1 THEN 'Authentication message' ELSE subject END, message = CASE WHEN sensitive=1 THEN '' ELSE message END WHERE status = 'PENDING' AND created_at < ?", [new Date(now).toISOString(), new Date(now - PENDING_RETENTION_MS).toISOString()]);
  return Number(pending?.affected_row_count ?? 0) + Number(expired?.affected_row_count ?? 0) + Number(settled?.affected_row_count ?? 0);
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
     WHERE recipient = ? AND COALESCE(sensitive,0)=0 AND template NOT IN ('auth_password_reset','auth_login_code')
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

export async function unreadNotificationCount(recipient: string) {
  const address = String(recipient || "").trim();
  if (!address || !(await isTursoConfiguredRuntime())) return 0;
  await ensureNotificationsTable();
  const rows = rowsToObjects(await turso("SELECT COUNT(*) AS count FROM notification_outbox WHERE recipient=? AND read_at IS NULL AND COALESCE(sensitive,0)=0 AND template NOT IN ('auth_password_reset','auth_login_code')", [address]));
  return Number(rows[0]?.count || 0);
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
    const result = await turso("UPDATE notification_outbox SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND COALESCE(sensitive,0)=0 AND template NOT IN ('auth_password_reset','auth_login_code')", [nowIso, address]);
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
  const text = await textConfig();
  const empty = {
    configured: false,
    provider: "resend",
    providerReady: resendReady(config),
    smsProvider: "sailup",
    smsProviderReady: sailupReady(text),
    pending: 0, sending: 0, sent: 0, failed: 0,
  };
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
 * Delivers due messages on the channel each row was queued for: mail through
 * Resend, texts through Sailup.
 *
 * Each message is claimed with an atomic UPDATE before sending, so overlapping
 * cron runs cannot deliver the same email twice. Retention pruning runs even
 * when both providers are unconfigured, so a dormant outbox stays bounded — and
 * because it runs before delivery in the same sweep, rows left over from the
 * retired SMS providers are deleted before any of them could be sent again.
 */
export async function dispatchPendingNotifications(input: { limit?: number; ids?: string[] } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { configured: false, sent: 0, failed: 0, considered: 0, pruned: 0 };
  await ensureNotificationsTable();
  // A queue-driven dispatch names its rows and delivers them immediately, so it
  // skips lease recovery and pruning: both belong to the cron sweep, and each
  // statement it skips is a subrequest the delivery keeps.
  const ids = (input.ids ?? []).map((id) => String(id || "").trim()).filter(Boolean).slice(0, 100);
  let pruned = 0;
  if (!ids.length) {
    await reclaimStaleNotifications(turso, { nowIso: new Date().toISOString() });
    pruned = await pruneNotifications(turso);
  }

  const config = await mailerConfig();
  const text = await textConfig();
  // Either channel alone is enough to sweep. A deployment that has not bought
  // texts must still send its mail, and one that has bought texts must still
  // send them when Resend is unset — so this is the one place the two providers
  // are allowed to stand in for each other.
  if (!resendReady(config) && !sailupReady(text)) return { configured: false, sent: 0, failed: 0, considered: 0, pruned };

  const limit = Math.max(1, Math.min(100, Math.round(input.limit || ids.length || DEFAULT_BATCH)));
  const idFilter = ids.length ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
  const due = rowsToObjects(await turso(
    `SELECT id,channel,recipient,subject,template,message,reference,attempts,sensitive,expires_at FROM notification_outbox WHERE status = 'PENDING' AND available_at <= ?${idFilter} ORDER BY created_at ASC LIMIT ?`,
    [new Date().toISOString(), ...ids, limit],
  ));
  // The feed shows the message alone; the link is added for the channel that
  // leaves the platform, as a CTA in mail and as a bare URL in a text.
  const appUrl = await envValue("CAMPUS_APP_URL");
  const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const id = String(row.id);
    const to = String(row.recipient || "").trim();
    const byText = String(row.channel || "") === "sms";
    const sensitive = Number(row.sensitive || 0) === 1 || /^auth_(password_reset|login_code)$/.test(String(row.template || ""));
    if (String(row.expires_at || "") && String(row.expires_at) <= new Date().toISOString()) {
      await turso("UPDATE notification_outbox SET status='FAILED',last_error='Message expired',subject=CASE WHEN ? THEN 'Authentication message' ELSE subject END,message=CASE WHEN ? THEN '' ELSE message END WHERE id=? AND status='PENDING'", [sensitive ? 1 : 0, sensitive ? 1 : 0, id]);
      failed += 1;
      continue;
    }
    // Missing provider credentials may be restored; retain the row for retry.
    if (byText ? !sailupReady(text) : !resendReady(config)) continue;
    if (byText ? !looksLikePhone(to) : !looksLikeEmail(to)) {
      await turso("UPDATE notification_outbox SET status='FAILED',last_error='Invalid recipient',subject=CASE WHEN ? THEN 'Authentication message' ELSE subject END,message=CASE WHEN ? THEN '' ELSE message END WHERE id=? AND status='PENDING'", [sensitive ? 1 : 0, sensitive ? 1 : 0, id]);
      failed += 1;
      continue;
    }
    // Another worker already owns this message; leave it to them.
    if (!(await claimNotification(turso, { id, leaseUntil }))) continue;
    const attempts = Number(row.attempts || 0) + 1;
    try {
      const template = String(row.template || "");
      const message = String(row.message || "");
      const action = notificationAction(template, String(row.reference || ""), message);
      const hosts = action?.href.startsWith("/console") ? parseConsoleHosts(await envValue("CONSOLE_HOSTS")) : [];
      const origin = hosts.length ? "https://" + hosts[0] : appUrl.replace(/\/$/, "");
      const url = action && origin ? origin + action.href : "";
      const cta = action?.label || "";
      const subject = String(row.subject || "") || humanizedTemplate(template);
      const result = byText
        ? await sendSms({ config: text, to, text: smsBody(message, url) })
        : await sendEmail({
          config,
          to,
          subject,
          text: emailBody(message, url, cta),
          html: renderNotificationEmail({ template, subject, message, appUrl, actionUrl: url, actionLabel: cta, replyTo: config.replyTo }),
        });
      if (!result.ok) throw new Error(result.error || "delivery failed");
      await turso("UPDATE notification_outbox SET status = 'SENT', sent_at = ?, last_error = '', subject = CASE WHEN ? THEN 'Authentication message' ELSE subject END, message = CASE WHEN ? THEN '' ELSE message END WHERE id = ? AND status = 'SENDING'", [new Date().toISOString(), sensitive ? 1 : 0, sensitive ? 1 : 0, id]);
      sent += 1;
      await incrementMetric("notification_sent");
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : "delivery failed";
      const exhausted = attempts >= MAX_ATTEMPTS;
      await turso(
        "UPDATE notification_outbox SET status = ?, last_error = ?, available_at = ?, subject = CASE WHEN ? THEN 'Authentication message' ELSE subject END, message = CASE WHEN ? THEN '' ELSE message END WHERE id = ? AND status = 'SENDING'",
        [exhausted ? "FAILED" : "PENDING", reason, new Date(Date.now() + notificationBackoffMs(attempts)).toISOString(), exhausted && sensitive ? 1 : 0, exhausted && sensitive ? 1 : 0, id],
      );
      failed += 1;
      await incrementMetric("notification_failed");
    }
  }

  if (due.length) logEvent("info", "notification_dispatch", { considered: due.length, sent, failed, pruned });
  return { configured: true, sent, failed, considered: due.length, pruned };
}
