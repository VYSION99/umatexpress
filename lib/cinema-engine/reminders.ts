import { ensureCinemaTables } from "@/lib/cinema-engine/rooms";
import { ensureNotificationsTable, isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
import { queueNotification } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";

/** Queues one deduplicated reminder per member or invitee shortly before start. */
export async function scanCinemaReminders(input: { now?: Date; limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { considered: 0, queued: 0 };
  await ensureCinemaTables();
  await ensureNotificationsTable();
  const now = input.now ?? new Date();
  const lower = new Date(now.getTime() + 10 * 60_000).toISOString();
  // Cinema uses every other 15-minute reminder slot, so its sweep is every
  // thirty minutes and looks across a matching thirty-minute window.
  const upper = new Date(now.getTime() + 40 * 60_000).toISOString();
  const limit = Math.max(1, Math.min(20, Math.round(input.limit || 12)));
  const rows = rowsToObjects(await turso(
    `SELECT s.id,s.title,s.starts_at,a.id AS student_id,a.email
       FROM cinema_sessions s
       JOIN (
         SELECT session_id,student_id FROM cinema_participants
         UNION SELECT session_id,student_id FROM cinema_room_invites
       ) audience ON audience.session_id=s.id
       JOIN student_accounts a ON a.id=audience.student_id AND COALESCE(a.active,1)=1
       LEFT JOIN notification_outbox n ON n.reference=('cinema:' || s.id || ':' || a.id) AND n.template='cinema_session_reminder'
      WHERE s.status='CREATED' AND s.starts_at<>'' AND datetime(s.starts_at) BETWEEN datetime(?) AND datetime(?) AND n.id IS NULL
      ORDER BY s.starts_at,s.id,a.id LIMIT ?`,
    [lower, upper, limit],
  ));
  let queued = 0;
  for (const row of rows) {
    const roomId = String(row.id || "");
    const startsAt = new Date(String(row.starts_at || ""));
    const time = Number.isNaN(startsAt.getTime()) ? "soon" : startsAt.toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });
    try {
      if (await queueNotification(turso, {
        recipient: String(row.email || ""),
        template: "cinema_session_reminder",
        subject: `${String(row.title || "Cinema room")} starts soon`,
        message: `${String(row.title || "Your Cinema room")} starts at ${time}. Open /cinema/${roomId} to join before it begins.`,
        reference: `cinema:${roomId}:${String(row.student_id || "")}`,
        nowIso: now.toISOString(),
      })) queued += 1;
    } catch (error) {
      logEvent("error", "cinema_reminder_queue_failed", { roomId, reason: error instanceof Error ? error.message : "unknown" });
    }
  }
  return { considered: rows.length, queued };
}
