import { ensureCinemaMessageTables, purgeCinemaMessages } from "@/lib/cinema-engine/messages";
import { cinemaRoomPresence, closeCinemaRoom, type CinemaRoomPresence } from "@/lib/cinema-engine/realtime";
import {
  ensureCinemaRecordingTables,
  purgeCinemaRecordingsForRoom,
  purgeExpiredCinemaRecordings,
} from "@/lib/cinema-engine/recordings";
import { ensureCinemaTables } from "@/lib/cinema-engine/rooms";
import { purgeCinemaUploadForRoom } from "@/lib/cinema-engine/uploads";
import {
  ensureCinemaWhiteboardTables,
  purgeCinemaWhiteboardsForRoom,
  purgeExpiredCinemaWhiteboards,
} from "@/lib/cinema-engine/whiteboard";
import { incrementMetric, logEvent } from "@/lib/observability";
import { platformSettingNumber } from "@/lib/platform-settings";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * Cinema cleanup, riding the Worker's existing reconciliation trigger.
 *
 * Two jobs in one run, both bounded so a single invocation's subrequest budget
 * is never spent here:
 *
 *  - Idle rooms end. A room that was created and never opened, or whose last
 *    socket left longer ago than `cinema_room_idle_minutes`, moves to ENDED and
 *    its sockets are told. Presence is the Durable Object's answer; when the
 *    object cannot be reached the job refuses to guess and ends nothing live.
 *  - Ended rooms expire. After `cinema_retention_hours`, chat and membership
 *    are purged, the room is marked DELETED and its row stays as a tombstone.
 *    A partial purge leaves the row at EXPIRED, where it serves nothing, and
 *    the next run finishes the work.
 *
 * The job never throws: a cron failure is logged and retried on the next tick.
 */

export type CinemaCleanupResult = {
  configured: boolean;
  idleEnded: number;
  deleted: number;
  /** Recordings past their retention window that were removed this run. */
  recordingsDeleted: number;
  /** AI boards past their retention window that were removed this run. */
  whiteboardsDeleted: number;
  /** True when the Durable Object could not be asked about live rooms. */
  presenceUnavailable: boolean;
};

type CleanupInput = {
  limit?: number;
  now?: number;
  /** Test seam; production reads the Durable Object. */
  presence?: (roomId: string) => Promise<CinemaRoomPresence | null>;
};

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 20;

export async function runCinemaCleanup(input: CleanupInput = {}): Promise<CinemaCleanupResult> {
  const limit = Math.min(Math.max(Math.round(Number(input.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const empty: CinemaCleanupResult = { configured: false, idleEnded: 0, deleted: 0, recordingsDeleted: 0, whiteboardsDeleted: 0, presenceUnavailable: false };
  try {
    if (!await isTursoConfiguredRuntime()) return empty;
    await ensureCinemaTables();
    await ensureCinemaMessageTables();
    await ensureCinemaRecordingTables();
    await ensureCinemaWhiteboardTables();
    const idleMinutes = await platformSettingNumber("cinema_room_idle_minutes");
    const retentionHours = await platformSettingNumber("cinema_retention_hours");
    const presence = input.presence ?? cinemaRoomPresence;
    const idle = await endIdleRooms({ limit, now, idleMs: idleMinutes * 60_000, presence });
    const expired = await deleteExpiredRooms({ limit, now, retentionMs: retentionHours * 60 * 60_000 });
    // Recordings outlive their row's room only until this window closes; a take
    // kept for a room that still exists is purged here rather than waiting for
    // the room itself to be deleted.
    const recordings = await purgeExpiredCinemaRecordings({ limit: 12, now });
    const whiteboards = await purgeExpiredCinemaWhiteboards({ limit: 20, now });
    if (idle.ended || expired.deleted || recordings.deleted || whiteboards.deleted || idle.presenceUnavailable) {
      logEvent("info", "cinema_cleanup_run", {
        idleEnded: idle.ended,
        deleted: expired.deleted,
        recordingsDeleted: recordings.deleted,
        whiteboardsDeleted: whiteboards.deleted,
        presenceUnavailable: idle.presenceUnavailable,
      });
    }
    return {
      configured: true,
      idleEnded: idle.ended,
      deleted: expired.deleted,
      recordingsDeleted: recordings.deleted,
      whiteboardsDeleted: whiteboards.deleted,
      presenceUnavailable: idle.presenceUnavailable,
    };
  } catch (error) {
    logEvent("error", "cinema_cleanup_failed", { reason: error instanceof Error ? error.message : "unknown" });
    return { ...empty, configured: true };
  }
}

/**
 * Rows old enough to be worth asking about. `updated_at` is the cheap filter,
 * not the verdict: a room can be live with no joins for hours, which is why
 * the Durable Object is asked before anything ends.
 */
async function endIdleRooms(input: {
  limit: number;
  now: number;
  idleMs: number;
  presence: (roomId: string) => Promise<CinemaRoomPresence | null>;
}) {
  const cutoff = new Date(input.now - input.idleMs).toISOString();
  const rows = rowsToObjects(await turso(
    `SELECT id,status,updated_at,created_at FROM cinema_sessions
      WHERE status IN ('CREATED','LIVE') AND updated_at <= ?
      ORDER BY updated_at ASC LIMIT ${input.limit}`,
    [cutoff],
  ));
  let ended = 0;
  let presenceUnavailable = false;
  for (const row of rows) {
    const id = String(row.id || "");
    const status = String(row.status || "");
    if (!id) continue;
    let idleSince: number;
    const presence = await input.presence(id);
    if (presence) {
      if (presence.memberCount > 0) {
        // Still watched. Move the activity stamp forward so this room stops
        // being a candidate for a whole idle window: otherwise four busy rooms
        // at the head of the queue would starve every idle room behind them.
        await turso("UPDATE cinema_sessions SET updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')", [new Date(input.now).toISOString(), id]);
        continue;
      }
      // An object that never saw a socket cannot say when the room emptied;
      // the row's own last write is then the honest proxy.
      idleSince = presence.emptySince > 0 ? presence.emptySince : Date.parse(String(row.updated_at || row.created_at || ""));
    } else if (status === "CREATED") {
      // A room nobody ever opened has no sockets to check: age is enough.
      idleSince = Date.parse(String(row.updated_at || row.created_at || ""));
      presenceUnavailable = true;
    } else {
      // A live room with an unreachable object must not be ended on a guess.
      presenceUnavailable = true;
      continue;
    }
    if (!Number.isFinite(idleSince) || input.now - idleSince < input.idleMs) continue;
    if (await endRoom(id, input.now)) ended += 1;
  }
  return { ended, presenceUnavailable };
}

async function endRoom(roomId: string, now: number) {
  const stamp = new Date(now).toISOString();
  const result = await turso(
    "UPDATE cinema_sessions SET status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
    [stamp, stamp, roomId],
  );
  if (!Number(result.affected_row_count || 0)) return false;
  await closeCinemaRoom(roomId);
  logEvent("info", "cinema_room_expired_idle", { roomId });
  await incrementMetric("cinema_rooms_expired_idle");
  return true;
}

/** ENDED → EXPIRED → DELETED, with the purge between the two marks. */
async function deleteExpiredRooms(input: { limit: number; now: number; retentionMs: number }) {
  const cutoff = new Date(input.now - input.retentionMs).toISOString();
  const rows = rowsToObjects(await turso(
    `SELECT id FROM cinema_sessions
      WHERE status IN ('ENDED','EXPIRED') AND ended_at <> '' AND ended_at <= ?
      ORDER BY ended_at ASC LIMIT ${input.limit}`,
    [cutoff],
  ));
  let deleted = 0;
  for (const row of rows) {
    const id = String(row.id || "");
    if (!id) continue;
    const stamp = new Date(input.now).toISOString();
    // EXPIRED first: even if the purge below fails, the room stops resolving.
    await turso(
      "UPDATE cinema_sessions SET status = 'EXPIRED', expired_at = ?, updated_at = ? WHERE id = ? AND status = 'ENDED'",
      [stamp, stamp, id],
    );
    // The video goes before the tombstone. A room marked DELETED while its
    // object is still in the bucket would be a retention promise the platform
    // did not keep, so a bucket that refuses leaves the room EXPIRED and the
    // next tick tries the whole purge again.
    const upload = await purgeCinemaUploadForRoom(id, { now: input.now });
    if (upload.status === "retry") continue;
    // Every take made in the room goes with it, for the same reason: a room
    // tombstone over bytes still in the bucket would be a retention promise
    // the platform did not keep.
    const recordings = await purgeCinemaRecordingsForRoom(id, { now: input.now });
    if (recordings.status === "retry") continue;
    await purgeCinemaWhiteboardsForRoom(id, { now: input.now });
    await purgeCinemaMessages(id);
    await turso("DELETE FROM cinema_participants WHERE session_id = ?", [id]);
    // The guest list goes with the membership it was written for.
    await turso("DELETE FROM cinema_room_invites WHERE session_id = ?", [id]);
    const result = await turso(
      "UPDATE cinema_sessions SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'EXPIRED'",
      [stamp, stamp, id],
    );
    if (!Number(result.affected_row_count || 0)) continue;
    deleted += 1;
    logEvent("info", "cinema_room_deleted", { roomId: id });
    await incrementMetric("cinema_rooms_deleted");
  }
  return { deleted };
}
