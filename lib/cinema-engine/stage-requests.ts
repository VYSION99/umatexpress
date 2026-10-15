import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom, setRoomMemberRole } from "@/lib/cinema-engine/rooms";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

let ready: Promise<void> | null = null;
function ensureStageRequests() {
  ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaStageRequests", version: "041_cinema_stage_requests", statements: [
    `CREATE TABLE IF NOT EXISTS cinema_stage_requests (
      session_id TEXT NOT NULL, student_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING', requested_at TEXT NOT NULL, decided_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(session_id,student_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_cinema_stage_requests_queue ON cinema_stage_requests(session_id,status,requested_at)",
  ] }).catch((error) => { ready = null; throw error; });
  return ready;
}

async function discussionRoom(id: string, studentId: string) {
  const room = await readRoom({ id, studentId });
  if (!room.discussionMode || !room.isMember) throw new CampusEngineError("FORBIDDEN", "Join the discussion before requesting the stage.", 403);
  return room;
}

export async function stageRequests(id: string, studentId: string) {
  const state = await discussionAudienceState(id, studentId);
  await ensureStageRequests();
  const manager = ["HOST", "COHOST"].includes(state.role);
  const rows = rowsToObjects(await turso(`SELECT session_id,student_id,display_name,status,requested_at FROM cinema_stage_requests
    WHERE session_id=? AND (student_id=? OR ?=1) AND status='PENDING' ORDER BY requested_at LIMIT 100`, [id, studentId, manager ? 1 : 0]));
  return rows.map(row => ({ studentId: String(row.student_id), displayName: String(row.display_name), requestedAt: String(row.requested_at) }));
}

export async function requestStage(input: { id: string; studentId: string; displayName: string }) {
  const room = await discussionRoom(input.id, input.studentId);
  if (room.currentRole !== "VIEWER") throw new CampusEngineError("INVALID_STATE", "You are already on the speaking stage.", 409);
  if (room.status !== "LIVE" && room.status !== "CREATED") throw new CampusEngineError("INVALID_STATE", "This discussion has ended.", 409);
  await ensureStageRequests();
  const existing = rowsToObjects(await turso("SELECT status,requested_at FROM cinema_stage_requests WHERE session_id=? AND student_id=? LIMIT 1", [input.id, input.studentId]))[0];
  if (String(existing?.status) === "PENDING") return { requested: true };
  if (String(existing?.status) === "REJECTED" && Date.now() - Date.parse(String(existing?.requested_at || "")) < 10 * 60_000) {
    throw new CampusEngineError("CONFLICT", "The host declined this request. You can ask again in ten minutes.", 409);
  }
  const stamp = new Date().toISOString();
  await turso(`INSERT INTO cinema_stage_requests(session_id,student_id,display_name,status,requested_at,decided_at)
    VALUES(?,?,?,'PENDING',?,'') ON CONFLICT(session_id,student_id) DO UPDATE SET display_name=excluded.display_name,status='PENDING',requested_at=excluded.requested_at,decided_at=''`,
  [input.id, input.studentId, input.displayName.slice(0, 80), stamp]);
  return { requested: true };
}

export async function decideStageRequest(input: { id: string; studentId: string; guestId: unknown; action: unknown }) {
  const room = await discussionRoom(input.id, input.studentId);
  if (!["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only the host or a co-host can admit a speaker.", 403);
  const guestId = String(input.guestId || "");
  const action = String(input.action || "").toUpperCase();
  if (!guestId || !["APPROVE", "REJECT"].includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a request and decision.", 400);
  await ensureStageRequests();
  const pending = rowsToObjects(await turso("SELECT student_id FROM cinema_stage_requests WHERE session_id=? AND student_id=? AND status='PENDING' LIMIT 1", [input.id, guestId]))[0];
  if (!pending) throw new CampusEngineError("NOT_FOUND", "That speaking request is no longer waiting.", 404);
  if (action === "APPROVE") {
    // The room's atomic stage-cap check decides whether a place is available.
    await setRoomMemberRole({ id: input.id, studentId: input.studentId, guestId, role: "PRESENTER" });
  }
  await turso("UPDATE cinema_stage_requests SET status=?,decided_at=? WHERE session_id=? AND student_id=? AND status='PENDING'", [action === "APPROVE" ? "APPROVED" : "REJECTED", new Date().toISOString(), input.id, guestId]);
  return { decided: true, action };
}

/** A small per-member read: no 200-person roster on every audience heartbeat. */
export async function discussionAudienceState(id: string, studentId: string) {
  const row = rowsToObjects(await turso(`SELECT s.status,s.title,s.video_id,s.discussion_mode,COALESCE(p.role,'VIEWER') AS role
    FROM cinema_sessions s JOIN cinema_participants p ON p.session_id=s.id AND p.student_id=?
    LEFT JOIN cinema_events e ON e.session_id=s.id
    LEFT JOIN cinema_organizers o ON o.id=e.organizer_id
    WHERE s.id=? AND s.status IN ('CREATED','LIVE','ENDED')
      AND (e.id IS NULL OR (e.status='PUBLISHED' AND o.status='ACTIVE' AND (o.organizer_type='STUDENT_GROUP' OR o.verified_at<>'')))
      AND (p.student_id=s.host_student_id OR e.id IS NULL OR EXISTS(
        SELECT 1 FROM cinema_event_rsvps r WHERE r.event_id=e.id AND r.student_id=p.student_id AND r.status='GOING'))
    LIMIT 1`, [studentId, id]))[0];
  if (!row || Number(row.discussion_mode || 0) !== 1) throw new CampusEngineError("FORBIDDEN", "Join this discussion first.", 403);
  return { status: String(row.status), title: String(row.title), videoId: String(row.video_id), role: String(row.role) };
}

/** Attendance uses observed activity, not merely an RSVP or a page load. */
export async function touchDiscussionAudience(id: string, studentId: string) {
  const stamp = new Date().toISOString();
  const result = await turso(`UPDATE cinema_participants SET
    attendance_seconds=attendance_seconds+CASE WHEN last_seen_at>=? AND last_seen_at<?
      THEN MIN(90,MAX(0,CAST((julianday(?) - julianday(last_seen_at))*86400 AS INTEGER))) ELSE 0 END,
    last_seen_at=?,left_at=''
    WHERE session_id=? AND student_id=? AND EXISTS(
      SELECT 1 FROM cinema_sessions s LEFT JOIN cinema_events e ON e.session_id=s.id
      LEFT JOIN cinema_organizers o ON o.id=e.organizer_id
      WHERE s.id=? AND s.discussion_mode=1 AND s.status='LIVE'
        AND (e.id IS NULL OR (e.status='PUBLISHED' AND o.status='ACTIVE' AND (o.organizer_type='STUDENT_GROUP' OR o.verified_at<>'')))
        AND (s.host_student_id=? OR e.id IS NULL OR EXISTS(
          SELECT 1 FROM cinema_event_rsvps r WHERE r.event_id=e.id AND r.student_id=? AND r.status='GOING')))`,
  [new Date(Date.now() - 90_000).toISOString(), stamp, stamp, stamp, id, studentId, id, studentId, studentId]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("FORBIDDEN", "Only live discussion attendees can record attendance.", 403);
  return { present: true };
}
