import { turso } from "@/lib/turso";

/**
 * Scheduled rooms: the host's clock for a room, and the row it moves.
 *
 * M12 lets a host say when the room goes live and how long it runs. The row is
 * the calendar — `starts_at`, `ends_at`, `duration_minutes` — and the room's
 * Durable Object is the alarm clock: it is handed both instants the moment the
 * room exists, and again on every socket, so a lost alarm is repaired by the
 * next visitor rather than by a new cron trigger.
 *
 * The arithmetic is pure so the bounds are testable without a database, and
 * the two UPDATEs are conditional so a room that already moved on — the host
 * opened it early, the cleanup job ended it — is never moved twice.
 */

/** A start more than a week out is a typo, not a plan. */
export const CINEMA_START_MAX_MINUTES = 7 * 24 * 60;
/** A room shorter than a quarter hour is a meet-up; longer than four hours is a vigil. */
export const CINEMA_DURATION_MIN_MINUTES = 15;
export const CINEMA_DURATION_MAX_MINUTES = 240;

/** Whether the host asked for a clock at all; absent keeps the legacy room. */
export function hasSchedule(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** How many minutes from now the room starts; null when it is not a time. */
export function parseStartInMinutes(value: unknown): number | null {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > CINEMA_START_MAX_MINUTES) return null;
  return numeric;
}

/** The host's run time; 0 means "until the host ends it", null an impossible one. */
export function parseDurationMinutes(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (numeric === 0) return 0;
  if (numeric < CINEMA_DURATION_MIN_MINUTES || numeric > CINEMA_DURATION_MAX_MINUTES) return null;
  return numeric;
}

/** The row's calendar from the host's choices and the server's own clock. */
export function scheduleFromNow(startInMinutes: number, durationMinutes: number, now: number) {
  const startsAt = new Date(now + startInMinutes * 60_000).toISOString();
  const endsAt = durationMinutes > 0
    ? new Date(now + (startInMinutes + durationMinutes) * 60_000).toISOString()
    : "";
  return { startsAt, endsAt };
}

/**
 * CREATED → LIVE. Called by the room's object when its alarm reaches the
 * scheduled minute, and by the engine when a due room is read before any
 * alarm: whoever gets there first wins, and the second call is a no-op.
 */
export async function markCinemaRoomLive(roomId: string, now: number): Promise<boolean> {
  const id = String(roomId || "").trim();
  if (!id) return false;
  const stamp = new Date(now).toISOString();
  const result = await turso(
    "UPDATE cinema_sessions SET status = 'LIVE', started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, updated_at = ? WHERE id = ? AND status = 'CREATED'",
    [stamp, stamp, id],
  );
  return Number(result.affected_row_count || 0) > 0;
}

/**
 * CREATED/LIVE → ENDED, at the minute the host's run time runs out. Ending a
 * room is a database decision first: the object closes its own sockets after
 * this returns, and a call that finds the room already ended does nothing.
 */
export async function markCinemaRoomEnded(roomId: string, now: number): Promise<boolean> {
  const id = String(roomId || "").trim();
  if (!id) return false;
  const stamp = new Date(now).toISOString();
  const result = await turso(
    "UPDATE cinema_sessions SET status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
    [stamp, stamp, id],
  );
  return Number(result.affected_row_count || 0) > 0;
}
