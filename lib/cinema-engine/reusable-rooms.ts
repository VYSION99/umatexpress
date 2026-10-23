import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";

export type ReusableCinemaRoom = {
  id: string;
  hostStudentId: string;
  currentSessionId: string;
  title: string;
  sourceType: "YOUTUBE" | "UPLOAD";
  videoId: string;
  visibility: "PUBLIC" | "PRIVATE";
  durationMinutes: number;
  currentStatus: string;
};

let ready: Promise<void> | null = null;
export function ensureReusableCinemaRooms() {
  ready ??= runSchemaPass({
    metaTable: "campus_schema_meta", id: "cinemaReusableRooms", version: "044_cinema_reusable_rooms",
    statements: [
      `CREATE TABLE IF NOT EXISTS cinema_reusable_rooms (
        id TEXT PRIMARY KEY, host_student_id TEXT NOT NULL, current_session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, source_type TEXT NOT NULL, video_id TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'PUBLIC', duration_minutes INTEGER NOT NULL DEFAULT 0,
        busy_token TEXT NOT NULL DEFAULT '', busy_until TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS idx_cinema_reusable_rooms_host ON cinema_reusable_rooms(host_student_id, updated_at DESC)",
      `CREATE TABLE IF NOT EXISTS cinema_reusable_room_guests (
        room_id TEXT NOT NULL, student_id TEXT NOT NULL, invited_by TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(room_id, student_id))`,
    ],
  }).catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

function view(row: Record<string, unknown>): ReusableCinemaRoom {
  return {
    id: String(row.id || ""), hostStudentId: String(row.host_student_id || ""),
    currentSessionId: String(row.current_session_id || ""), title: String(row.title || ""),
    sourceType: String(row.source_type) === "UPLOAD" ? "UPLOAD" : "YOUTUBE",
    videoId: String(row.video_id || ""), visibility: String(row.visibility) === "PRIVATE" ? "PRIVATE" : "PUBLIC",
    durationMinutes: Math.max(0, Number(row.duration_minutes || 0)), currentStatus: String(row.current_status || "DELETED"),
  };
}

export async function registerReusableCinemaRoom(input: {
  id: string; hostStudentId: string; title: string; sourceType: "YOUTUBE" | "UPLOAD";
  videoId: string; visibility: "PUBLIC" | "PRIVATE"; durationMinutes: number;
}) {
  await ensureReusableCinemaRooms();
  const stamp = new Date().toISOString();
  await turso(`INSERT INTO cinema_reusable_rooms
    (id,host_student_id,current_session_id,title,source_type,video_id,visibility,duration_minutes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [input.id, input.hostStudentId, input.id, input.title, input.sourceType,
      input.sourceType === "UPLOAD" ? "" : input.videoId, input.visibility, input.durationMinutes, stamp, stamp]);
}

export async function reusableRoomById(id: string): Promise<ReusableCinemaRoom | null> {
  await ensureReusableCinemaRooms();
  const row = rowsToObjects(await turso(`SELECT p.*,COALESCE(s.status,'DELETED') AS current_status
    FROM cinema_reusable_rooms p LEFT JOIN cinema_sessions s ON s.id=p.current_session_id WHERE p.id=? LIMIT 1`, [id]))[0];
  return row ? view(row) : null;
}

export async function reusableRoomForSession(sessionId: string): Promise<ReusableCinemaRoom | null> {
  await ensureReusableCinemaRooms();
  const row = rowsToObjects(await turso(`SELECT p.*,COALESCE(s.status,'DELETED') AS current_status
    FROM cinema_reusable_rooms p LEFT JOIN cinema_sessions s ON s.id=p.current_session_id
    WHERE p.current_session_id=? OR p.id=? LIMIT 1`, [sessionId, sessionId]))[0];
  return row ? view(row) : null;
}

export async function listReusableCinemaRooms(hostStudentId: string): Promise<ReusableCinemaRoom[]> {
  await ensureReusableCinemaRooms();
  const rows = rowsToObjects(await turso(`SELECT p.*,COALESCE(s.status,'DELETED') AS current_status
    FROM cinema_reusable_rooms p LEFT JOIN cinema_sessions s ON s.id=p.current_session_id
    WHERE p.host_student_id=? ORDER BY p.updated_at DESC LIMIT 30`, [hostStudentId]));
  return rows.map(view);
}

export async function saveLegacyCinemaRoom(sessionId: string, hostStudentId: string) {
  await ensureReusableCinemaRooms();
  const row = rowsToObjects(await turso(`SELECT s.id,s.host_student_id,s.title,s.video_source_type,s.video_id,
    s.visibility,s.duration_minutes,s.status FROM cinema_sessions s WHERE s.id=? LIMIT 1`, [sessionId]))[0];
  if (!row || String(row.host_student_id) !== hostStudentId) throw new CampusEngineError("FORBIDDEN", "Only the host can reuse this room.", 403);
  let event: Record<string, unknown> | undefined;
  try { event = rowsToObjects(await turso("SELECT id FROM cinema_events WHERE session_id=? LIMIT 1", [sessionId]))[0]; }
  catch (error) { if (!(error instanceof Error && /no such table: cinema_events/i.test(error.message))) throw error; }
  if (event) throw new CampusEngineError("INVALID_STATE", "Events are published separately and cannot be reused as watch rooms.", 409);
  const stamp = new Date().toISOString();
  await turso(`INSERT OR IGNORE INTO cinema_reusable_rooms
    (id,host_student_id,current_session_id,title,source_type,video_id,visibility,duration_minutes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [sessionId, hostStudentId, sessionId, String(row.title || "Study room"),
      String(row.video_source_type || "YOUTUBE"), String(row.video_source_type) === "UPLOAD" ? "" : String(row.video_id || ""),
      String(row.visibility || "PUBLIC"), Number(row.duration_minutes || 0), stamp, stamp]);
  await turso(`INSERT OR IGNORE INTO cinema_reusable_room_guests(room_id,student_id,invited_by,created_at)
    SELECT ?,student_id,invited_by,created_at FROM cinema_room_invites WHERE session_id=?`, [sessionId, sessionId]);
  return reusableRoomById(sessionId);
}

export async function acquireReusableRoom(id: string, expectedSessionId: string) {
  const token = crypto.randomUUID();
  const now = new Date();
  const result = await turso(`UPDATE cinema_reusable_rooms SET busy_token=?,busy_until=?
    WHERE id=? AND current_session_id=? AND (busy_token='' OR busy_until<?)`,
    [token, new Date(now.getTime() + 90_000).toISOString(), id, expectedSessionId, now.toISOString()]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("CONFLICT", "This room is already starting. Refresh its link.", 409);
  return token;
}

export async function releaseReusableRoom(id: string, token: string) {
  await turso("UPDATE cinema_reusable_rooms SET busy_token='',busy_until='' WHERE id=? AND busy_token=?", [id, token]);
}

export async function activateReusableRoom(profile: ReusableCinemaRoom, token: string, nextSessionId: string) {
  const stamp = new Date().toISOString();
  await turso(`INSERT OR IGNORE INTO cinema_room_invites(session_id,student_id,invited_by,created_at)
    SELECT ?,student_id,invited_by,created_at FROM cinema_reusable_room_guests WHERE room_id=?`, [nextSessionId, profile.id]);
  const result = await turso(`UPDATE cinema_reusable_rooms SET current_session_id=?,busy_token='',busy_until='',updated_at=?
    WHERE id=? AND current_session_id=? AND busy_token=?`, [nextSessionId, stamp, profile.id, profile.currentSessionId, token]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("CONFLICT", "This room changed while starting. Refresh its link.", 409);
}

export async function updateReusableRoomProfile(sessionId: string, fields: { title?: string; visibility?: string }) {
  await ensureReusableCinemaRooms();
  if (fields.title) await turso("UPDATE cinema_reusable_rooms SET title=?,updated_at=? WHERE current_session_id=?", [fields.title, new Date().toISOString(), sessionId]);
  if (fields.visibility) await turso("UPDATE cinema_reusable_rooms SET visibility=?,updated_at=? WHERE current_session_id=?", [fields.visibility, new Date().toISOString(), sessionId]);
}

export async function syncReusableRoomGuest(sessionId: string, studentId: string, invitedBy: string, add: boolean) {
  await ensureReusableCinemaRooms();
  const profile = await reusableRoomForSession(sessionId);
  if (!profile || profile.currentSessionId !== sessionId) return;
  if (add) await turso("INSERT OR IGNORE INTO cinema_reusable_room_guests(room_id,student_id,invited_by,created_at) VALUES(?,?,?,?)",
    [profile.id, studentId, invitedBy, new Date().toISOString()]);
  else await turso("DELETE FROM cinema_reusable_room_guests WHERE room_id=? AND student_id=?", [profile.id, studentId]);
}

export async function forgetReusableCinemaRoom(id: string, hostStudentId: string) {
  const profile = await reusableRoomById(id);
  if (!profile || profile.hostStudentId !== hostStudentId) throw new CampusEngineError("FORBIDDEN", "Only the host can remove this saved room.", 403);
  if (profile.currentStatus === "LIVE" || profile.currentStatus === "CREATED") throw new CampusEngineError("INVALID_STATE", "End the current session before removing its saved room.", 409);
  const token = await acquireReusableRoom(id, profile.currentSessionId);
  try {
    const [removed] = await tursoTransaction([
      { sql: "DELETE FROM cinema_reusable_rooms WHERE id=? AND host_student_id=? AND current_session_id=? AND busy_token=?", args: [id, hostStudentId, profile.currentSessionId, token] },
      { sql: "DELETE FROM cinema_reusable_room_guests WHERE room_id=? AND NOT EXISTS(SELECT 1 FROM cinema_reusable_rooms WHERE id=?)", args: [id, id] },
    ]);
    if (Number(removed.affected_row_count || 0) !== 1) throw new CampusEngineError("CONFLICT", "The saved room changed. Refresh and try again.", 409);
  } finally { await releaseReusableRoom(id, token).catch(() => undefined); }
}
