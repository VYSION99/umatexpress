import { CampusEngineError } from "@/lib/campus-engine/errors";
import { privateBucket } from "@/lib/cloudflare-bindings";
import { createRoom, ensureCinemaTables } from "@/lib/cinema-engine/rooms";
import { ensureNotificationsTable, isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";
import { queueNotification } from "@/lib/notifications";
import { parseYouTubeId } from "@/lib/cinema-engine/youtube";
import { cancelReservedFreeJaasEntitlement, ensureCinemaStreamingEntitlements, freeJaasPolicy, reserveFreeJaasEntitlement } from "@/lib/cinema-streaming/entitlements";
import { jaasRuntime } from "@/lib/cinema-streaming/jaas";

export const CINEMA_EVENT_SCHEMA_VERSION = "043_cinema_organizer_evidence";
export const CINEMA_ORGANIZER_TYPES = ["CLUB", "DEPARTMENT", "STUDENT_GROUP"] as const;
export type CinemaOrganizerType = (typeof CINEMA_ORGANIZER_TYPES)[number];
export const CINEMA_EVENT_FORMATS = ["SCREENING", "DEBATE", "PANEL"] as const;
export type CinemaEventFormat = (typeof CINEMA_EVENT_FORMATS)[number];
/** Cinema is a focused broadcast and panel venue. Raise only after a deployed load test. */
export const CINEMA_DISCUSSION_CAPACITY_MAX = 100;

const EVENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cinema_organizers (
    id TEXT PRIMARY KEY, owner_student_id TEXT NOT NULL, name TEXT NOT NULL,
    organizer_type TEXT NOT NULL DEFAULT 'STUDENT_GROUP', description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_organizers_owner ON cinema_organizers(owner_student_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS cinema_events (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, organizer_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
    series_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL DEFAULT '', capacity INTEGER NOT NULL DEFAULT 0,
    poster_key TEXT NOT NULL DEFAULT '', poster_content_type TEXT NOT NULL DEFAULT '',
    certificates_enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'PUBLISHED',
    recurrence_index INTEGER NOT NULL DEFAULT 1, recurrence_count INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_events_catalogue ON cinema_events(status, starts_at)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_events_organizer ON cinema_events(organizer_id, starts_at DESC)",
  `CREATE TABLE IF NOT EXISTS cinema_event_rsvps (
    event_id TEXT NOT NULL, student_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'GOING',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(event_id, student_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_event_rsvps_student ON cinema_event_rsvps(student_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS cinema_event_feedback (
    event_id TEXT NOT NULL, student_id TEXT NOT NULL, rating INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(event_id, student_id)
  )`,
  "ALTER TABLE cinema_events ADD COLUMN event_format TEXT NOT NULL DEFAULT 'SCREENING'",
  "ALTER TABLE cinema_events ADD COLUMN stage_limit INTEGER NOT NULL DEFAULT 6",
  "ALTER TABLE cinema_organizers ADD COLUMN verified_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE cinema_organizers ADD COLUMN verified_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE cinema_organizers ADD COLUMN verification_note TEXT NOT NULL DEFAULT ''",
  "UPDATE cinema_events SET capacity=100 WHERE capacity=0 OR capacity>100",
];

let ready: Promise<void> | null = null;
export function ensureCinemaEventTables() {
  ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaEvents", version: CINEMA_EVENT_SCHEMA_VERSION, statements: EVENT_SCHEMA }).catch((error) => { ready = null; throw error; });
  return ready;
}

async function requireRuntime() {
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Cinema events need the configured database.", 503);
  await Promise.all([ensureCinemaTables(), ensureCinemaEventTables(), ensureCinemaStreamingEntitlements()]);
}

export type CinemaEvent = {
  id: string; slug: string; sessionId: string; seriesId: string; title: string; description: string;
  startsAt: string; endsAt: string; capacity: number; rsvpCount: number; availablePlaces: number | null;
  format: CinemaEventFormat; stageLimit: number; waitlistCount: number; waitlistPosition: number;
  posterUrl: string; certificatesEnabled: boolean; status: string; state: "UPCOMING" | "LIVE" | "REPLAY";
  replayVideoId: string;
  recurrenceIndex: number; recurrenceCount: number; organizer: { id: string; name: string; type: CinemaOrganizerType };
  averageRating: number; ratingCount: number; viewerRsvp: "" | "GOING" | "WAITLIST" | "CANCELLED"; canManage: boolean;
  managedStage: boolean;
};

const SELECT_EVENT = `SELECT e.*,o.name AS organizer_name,o.organizer_type,o.status AS organizer_status,o.verified_at AS organizer_verified_at,
  (SELECT COUNT(*) FROM cinema_event_rsvps r WHERE r.event_id=e.id AND r.status='GOING') AS rsvp_count,
  (SELECT COUNT(*) FROM cinema_event_rsvps r WHERE r.event_id=e.id AND r.status='WAITLIST') AS waitlist_count,
  (SELECT ROUND(AVG(f.rating),1) FROM cinema_event_feedback f WHERE f.event_id=e.id) AS average_rating,
  (SELECT COUNT(*) FROM cinema_event_feedback f WHERE f.event_id=e.id) AS rating_count,
  COALESCE(s.status,'CREATED') AS room_status,s.video_id AS room_video_id,s.video_source_type AS room_source_type,
  EXISTS(SELECT 1 FROM cinema_streaming_entitlements se WHERE se.event_id=e.id AND se.provider='JAAS' AND se.status IN ('RESERVED','ACTIVE')) AS managed_stage`;

function eventView(row: Record<string, unknown>, studentId = ""): CinemaEvent {
  const capacity = Number(row.capacity || 0);
  const rsvpCount = Number(row.rsvp_count || 0);
  const roomStatus = String(row.room_status || "CREATED");
  const starts = Date.parse(String(row.starts_at || ""));
  const ends = Date.parse(String(row.ends_at || ""));
  const now = Date.now();
  const state: CinemaEvent["state"] = roomStatus === "ENDED" || roomStatus === "EXPIRED" || (Number.isFinite(ends) && ends <= now)
    ? "REPLAY"
    : roomStatus === "LIVE" || (Number.isFinite(starts) && starts <= now) ? "LIVE" : "UPCOMING";
  return {
    id: String(row.id || ""), slug: String(row.slug || ""), sessionId: String(row.session_id || ""), seriesId: String(row.series_id || ""),
    title: String(row.title || "Cinema event"), description: String(row.description || ""), startsAt: String(row.starts_at || ""), endsAt: String(row.ends_at || ""),
    capacity, rsvpCount, availablePlaces: capacity > 0 ? Math.max(0, capacity - rsvpCount) : null,
    format: CINEMA_EVENT_FORMATS.includes(String(row.event_format || "SCREENING") as CinemaEventFormat) ? String(row.event_format) as CinemaEventFormat : "SCREENING",
    stageLimit: Number(row.stage_limit || 6), waitlistCount: Number(row.waitlist_count || 0), waitlistPosition: Number(row.waitlist_position || 0),
    posterUrl: row.poster_key ? `/api/cinema/events/${String(row.id)}/poster` : "", certificatesEnabled: Number(row.certificates_enabled || 0) === 1,
    replayVideoId: state === "REPLAY" && String(row.room_source_type) === "YOUTUBE" ? String(row.room_video_id || "") : "",
    status: String(row.status || "PUBLISHED"), state, recurrenceIndex: Number(row.recurrence_index || 1), recurrenceCount: Number(row.recurrence_count || 1),
    organizer: { id: String(row.organizer_id || ""), name: String(row.organizer_name || "Student group"), type: String(row.organizer_type || "STUDENT_GROUP") as CinemaOrganizerType },
    averageRating: Number(row.average_rating || 0), ratingCount: Number(row.rating_count || 0),
    viewerRsvp: String(row.viewer_rsvp || "") as CinemaEvent["viewerRsvp"], canManage: Boolean(studentId) && String(row.created_by || "") === studentId,
    managedStage: Number(row.managed_stage || 0) === 1,
  };
}

function cleanText(value: unknown, max: number) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function slugFor(title: string) {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 52) || "event";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function listPublicCinemaEvents(input: { section?: unknown; query?: unknown; studentId?: string; limit?: number } = {}) {
  await requireRuntime();
  const section = String(input.section || "ALL").toUpperCase();
  const query = cleanText(input.query, 80).toLowerCase();
  const limit = Math.max(1, Math.min(60, Math.floor(Number(input.limit) || 36)));
  const now = new Date().toISOString();
  const sectionSql = section === "UPCOMING"
    ? "AND s.status='CREATED' AND e.starts_at>?"
    : section === "LIVE"
      ? "AND s.status NOT IN ('ENDED','EXPIRED') AND (s.status='LIVE' OR e.starts_at<=?) AND e.ends_at>?"
      : section === "REPLAY"
        ? "AND (s.status IN ('ENDED','EXPIRED') OR e.ends_at<=?)"
        : "";
  const sectionArgs = section === "LIVE" ? [now, now] : sectionSql ? [now] : [];
  const order = section === "REPLAY" ? "e.starts_at DESC" : "e.starts_at ASC";
  const rows = rowsToObjects(await turso(
    `${SELECT_EVENT},COALESCE(r.status,'') AS viewer_rsvp
       FROM cinema_events e JOIN cinema_organizers o ON o.id=e.organizer_id
       JOIN cinema_sessions s ON s.id=e.session_id
       LEFT JOIN cinema_event_rsvps r ON r.event_id=e.id AND r.student_id=?
      WHERE e.status='PUBLISHED' AND o.status='ACTIVE' AND (o.organizer_type='STUDENT_GROUP' OR o.verified_at<>'')
        AND (?='' OR lower(e.title || ' ' || e.description || ' ' || o.name) LIKE ?)
        ${sectionSql}
      ORDER BY ${section === "ALL" ? "CASE s.status WHEN 'LIVE' THEN 0 WHEN 'CREATED' THEN 1 ELSE 2 END,e.starts_at ASC" : order} LIMIT ?`,
    [String(input.studentId || ""), query, `%${query}%`, ...sectionArgs, limit],
  ));
  return rows.map((row) => eventView(row, input.studentId));
}

export async function readPublicCinemaEvent(idOrSlug: string, studentId = "") {
  await requireRuntime();
  const row = rowsToObjects(await turso(
    `${SELECT_EVENT},COALESCE(r.status,'') AS viewer_rsvp,
       (SELECT COUNT(*) FROM cinema_event_rsvps ahead WHERE ahead.event_id=e.id AND ahead.status='WAITLIST' AND (ahead.created_at<r.created_at OR (ahead.created_at=r.created_at AND ahead.student_id<=r.student_id))) AS waitlist_position
       FROM cinema_events e JOIN cinema_organizers o ON o.id=e.organizer_id
       JOIN cinema_sessions s ON s.id=e.session_id
       LEFT JOIN cinema_event_rsvps r ON r.event_id=e.id AND r.student_id=?
      WHERE (e.id=? OR e.slug=?) AND e.status<>'DELETED' LIMIT 1`, [studentId, idOrSlug, idOrSlug],
  ))[0];
  const organizerApproved = row && String(row.organizer_status) === "ACTIVE" && (String(row.organizer_type) === "STUDENT_GROUP" || Boolean(row.organizer_verified_at));
  if (!row || ((!organizerApproved || String(row.status) !== "PUBLISHED") && String(row.created_by) !== studentId)) throw new CampusEngineError("NOT_FOUND", "That event was not found.", 404);
  return eventView(row, studentId);
}

async function organizerFor(input: { studentId: string; name: unknown; type: unknown }) {
  const name = cleanText(input.name, 100);
  const type = String(input.type || "STUDENT_GROUP").toUpperCase() as CinemaOrganizerType;
  if (name.length < 2) throw new CampusEngineError("VALIDATION_ERROR", "Add the club, department, or group name.", 400);
  if (!CINEMA_ORGANIZER_TYPES.includes(type)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid organizer type.", 400);
  const existing = rowsToObjects(await turso("SELECT id FROM cinema_organizers WHERE owner_student_id=? AND lower(name)=lower(?) AND organizer_type=? AND status='ACTIVE' AND (organizer_type='STUDENT_GROUP' OR verified_at<>'') LIMIT 1", [input.studentId, name, type]))[0];
  if (existing) return String(existing.id);
  if (type !== "STUDENT_GROUP") throw new CampusEngineError("FORBIDDEN", "A club or department must be approved by Cinema staff before publishing. Request approval from the event form.", 403);
  const id = crypto.randomUUID(); const stamp = new Date().toISOString();
  await turso("INSERT INTO cinema_organizers(id,owner_student_id,name,organizer_type,description,status,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?)", [id, input.studentId, name, type, "", stamp, stamp]);
  return id;
}

export async function listMyCinemaOrganizers(studentId: string) {
  await requireRuntime();
  return rowsToObjects(await turso("SELECT id,name,organizer_type,status,verified_at,created_at,updated_at FROM cinema_organizers WHERE owner_student_id=? ORDER BY created_at DESC LIMIT 100", [studentId])).map((row) => ({
    id: String(row.id), name: String(row.name), type: String(row.organizer_type) as CinemaOrganizerType,
    status: String(row.status) === "ACTIVE" && String(row.organizer_type) !== "STUDENT_GROUP" && !row.verified_at ? "UNVERIFIED" : String(row.status),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }));
}

export async function requestCinemaOrganizer(input: { studentId: string; name: unknown; type: unknown; affiliation: unknown }) {
  await requireRuntime();
  const name = cleanText(input.name, 100);
  const type = String(input.type || "").toUpperCase() as CinemaOrganizerType;
  if (name.length < 2 || !["CLUB", "DEPARTMENT"].includes(type)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a club or department and enter its name.", 400);
  const affiliation = cleanText(input.affiliation, 500);
  if (affiliation.length < 10) throw new CampusEngineError("VALIDATION_ERROR", "Explain your role and provide a staff contact or other affiliation reference.", 400);
  const existing = rowsToObjects(await turso("SELECT id,status,verified_at FROM cinema_organizers WHERE owner_student_id=? AND lower(name)=lower(?) AND organizer_type=? ORDER BY created_at DESC LIMIT 1", [input.studentId, name, type]))[0];
  if (existing) {
    if (String(existing.status) === "ACTIVE" && existing.verified_at) return { id: String(existing.id), status: "ACTIVE" };
    if (String(existing.status) === "PENDING") {
      await turso("UPDATE cinema_organizers SET description=?,updated_at=? WHERE id=?", [affiliation, new Date().toISOString(), String(existing.id)]);
      return { id: String(existing.id), status: "PENDING" };
    }
    await turso("UPDATE cinema_organizers SET status='PENDING',description=?,verified_at='',verified_by='',verification_note='',updated_at=? WHERE id=?", [affiliation, new Date().toISOString(), String(existing.id)]);
    return { id: String(existing.id), status: "PENDING" };
  }
  const id = crypto.randomUUID(); const stamp = new Date().toISOString();
  await turso("INSERT INTO cinema_organizers(id,owner_student_id,name,organizer_type,description,status,created_at,updated_at) VALUES(?,?,?,?,?,'PENDING',?,?)", [id, input.studentId, name, type, affiliation, stamp, stamp]);
  return { id, status: "PENDING" };
}

export async function listPendingCinemaOrganizers() {
  await requireRuntime();
  return rowsToObjects(await turso("SELECT o.id,o.name,o.organizer_type,o.description,o.created_at,a.email AS owner_email FROM cinema_organizers o JOIN student_accounts a ON a.id=o.owner_student_id WHERE o.status='PENDING' ORDER BY o.created_at ASC LIMIT 100", []));
}

export async function decideCinemaOrganizer(input: { id: string; approve: boolean; actor: string; verificationNote: unknown }) {
  await requireRuntime();
  const verificationNote = cleanText(input.verificationNote, 500);
  if (verificationNote.length < 10) throw new CampusEngineError("VALIDATION_ERROR", "Record the affiliation check or rejection reason before deciding.", 400);
  const status = input.approve ? "ACTIVE" : "REJECTED";
  const stamp = new Date().toISOString();
  const result = await turso("UPDATE cinema_organizers SET status=?,verified_at=?,verified_by=?,verification_note=?,updated_at=? WHERE id=? AND status='PENDING'", [status, input.approve ? stamp : "", input.actor, verificationNote, stamp, input.id]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("NOT_FOUND", "That pending organizer request was not found.", 404);
  return { id: input.id, status };
}

export async function createCinemaEvents(input: {
  student: { id: string; name?: string }; organizerName?: unknown; organizerType?: unknown; title?: unknown; description?: unknown;
  video?: unknown; startsAt?: unknown; durationMinutes?: unknown; capacity?: unknown; recurrenceCount?: unknown; certificatesEnabled?: unknown;
  format?: unknown; stageLimit?: unknown; managedStage?: unknown;
}) {
  await requireRuntime();
  const title = cleanText(input.title, 80); const description = cleanText(input.description, 1200);
  if (title.length < 3) throw new CampusEngineError("VALIDATION_ERROR", "Give the event a clear title.", 400);
  const parsedVideo = parseYouTubeId(input.video);
  if (!parsedVideo.ok) throw new CampusEngineError("VALIDATION_ERROR", parsedVideo.reason, 400);
  const recurrenceCount = Number(input.recurrenceCount ?? 1);
  if (!Number.isInteger(recurrenceCount) || recurrenceCount < 1 || recurrenceCount > 8) throw new CampusEngineError("VALIDATION_ERROR", "Choose one to eight weekly sessions.", 400);
  const first = Date.parse(String(input.startsAt || ""));
  const now = Date.now();
  const last = first + (recurrenceCount - 1) * 7 * 24 * 60 * 60_000;
  if (!Number.isFinite(first) || first < now - 60_000 || last > now + 60 * 24 * 60 * 60_000) throw new CampusEngineError("VALIDATION_ERROR", "Choose dates that fit within the next 60 days.", 400);
  const requestedCapacity = Number(input.capacity ?? 100);
  const capacity = requestedCapacity === 0 ? CINEMA_DISCUSSION_CAPACITY_MAX : requestedCapacity;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > CINEMA_DISCUSSION_CAPACITY_MAX) throw new CampusEngineError("VALIDATION_ERROR", "Choose an attendance limit from 1 to 100.", 400);
  const format = String(input.format || "SCREENING").toUpperCase() as CinemaEventFormat;
  if (!CINEMA_EVENT_FORMATS.includes(format)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid event format.", 400);
  if (format !== "SCREENING" && capacity < 10) throw new CampusEngineError("VALIDATION_ERROR", "Set a discussion audience threshold of at least 10.", 400);
  if (format !== "SCREENING" && capacity > CINEMA_DISCUSSION_CAPACITY_MAX) throw new CampusEngineError("VALIDATION_ERROR", `Discussion attendance is currently limited to ${CINEMA_DISCUSSION_CAPACITY_MAX}.`, 400);
  const stageLimit = Number(input.stageLimit ?? 6);
  if (!Number.isInteger(stageLimit) || stageLimit < 2 || stageLimit > 6) throw new CampusEngineError("VALIDATION_ERROR", "Choose two to six stage places.", 400);
  const duration = Number(input.durationMinutes ?? 60);
  if (!Number.isInteger(duration) || duration < 15 || duration > 240) throw new CampusEngineError("VALIDATION_ERROR", "Choose a duration from 15 minutes to four hours.", 400);
  const managedStage = input.managedStage === true || String(input.managedStage || "").toLowerCase() === "true";
  const [managedPolicy, managedRuntime] = managedStage
    ? await Promise.all([freeJaasPolicy(), jaasRuntime()])
    : [null, null];
  if (managedStage && format === "SCREENING") throw new CampusEngineError("VALIDATION_ERROR", "The managed stage is available for debates and panel discussions.", 400);
  if (managedStage && recurrenceCount !== 1) throw new CampusEngineError("VALIDATION_ERROR", "Create each free managed-stage event separately so its organizer allowance can be checked.", 400);
  if (managedStage && !managedPolicy?.enabled) throw new CampusEngineError("CONFIG_REQUIRED", "Free managed-stage events are not currently available.", 503);
  if (managedStage && !managedRuntime?.configured) throw new CampusEngineError("CONFIG_REQUIRED", "The managed-stage signing credentials are incomplete.", 503);
  if (managedStage && duration > Number(managedPolicy?.maxDurationMinutes || 0)) throw new CampusEngineError("VALIDATION_ERROR", `A free managed-stage event may run for up to ${managedPolicy?.maxDurationMinutes || 60} minutes.`, 400);
  const effectiveStageLimit = managedStage ? Number(managedPolicy?.maxStageUnique || 4) : stageLimit;
  const organizerId = await organizerFor({ studentId: input.student.id, name: input.organizerName, type: input.organizerType });
  const organizer = rowsToObjects(await turso("SELECT owner_student_id,organizer_type FROM cinema_organizers WHERE id=? LIMIT 1", [organizerId]))[0];
  if (!organizer) throw new CampusEngineError("NOT_FOUND", "That Cinema organizer was not found.", 404);
  const seriesId = recurrenceCount > 1 ? crypto.randomUUID() : "";
  const created: string[] = [];
  for (let index = 0; index < recurrenceCount; index++) {
    const occurrence = first + index * 7 * 24 * 60 * 60_000;
    const id = crypto.randomUUID();
    let roomId = "";
    try {
      const room = await createRoom({ student: input.student, title, video: input.video, source: "YOUTUBE", visibility: "PUBLIC", startInMinutes: Math.max(0, Math.round((occurrence - Date.now()) / 60_000)), durationMinutes: duration, scheduleHorizonMinutes: 60 * 24 * 60 });
      roomId = room.id;
      if (format !== "SCREENING") await turso("UPDATE cinema_sessions SET discussion_mode=1,stage_limit=? WHERE id=?", [effectiveStageLimit, room.id]);
      const stamp = new Date().toISOString();
      await turso(`INSERT INTO cinema_events(id,slug,organizer_id,session_id,series_id,title,description,starts_at,ends_at,capacity,certificates_enabled,status,recurrence_index,recurrence_count,created_by,created_at,updated_at,event_format,stage_limit)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'PUBLISHING',?,?,?,?,?,?,?)`, [id, slugFor(title), organizerId, room.id, seriesId, title, description, room.startsAt, room.endsAt, capacity, input.certificatesEnabled ? 1 : 0, index + 1, recurrenceCount, input.student.id, stamp, stamp, format, effectiveStageLimit]);
      if (managedStage && managedPolicy) await reserveFreeJaasEntitlement({
        eventId: id, organizerId, organizerType: String(organizer.organizer_type), ownerStudentId: String(organizer.owner_student_id),
        hostStudentId: input.student.id, startsAt: room.startsAt, durationMinutes: duration, createdBy: input.student.id, policy: managedPolicy,
      });
      created.push(id);
    } catch (error) {
      await cancelReservedFreeJaasEntitlement(id).catch(() => undefined);
      await turso("DELETE FROM cinema_events WHERE id=? AND status='PUBLISHING'", [id]).catch(() => undefined);
      if (roomId) {
        await turso("DELETE FROM cinema_participants WHERE session_id=?", [roomId]).catch(() => undefined);
        await turso("DELETE FROM cinema_sessions WHERE id=?", [roomId]).catch(() => undefined);
      }
      throw error;
    }
  }
  // Publish the whole series in one write. A failed occurrence cannot leave a
  // misleading partial series in the public catalogue.
  try {
    await turso(`UPDATE cinema_events SET status='PUBLISHED',updated_at=? WHERE id IN (${created.map(() => "?").join(",")})`, [new Date().toISOString(), ...created]);
  } catch (error) {
    for (const id of created) await cancelReservedFreeJaasEntitlement(id).catch(() => undefined);
    throw error;
  }
  return Promise.all(created.map((id) => readPublicCinemaEvent(id, input.student.id)));
}

export async function setCinemaEventRsvp(input: { id: string; student: { id: string; email: string }; going: boolean }) {
  await requireRuntime();
  const event = await readPublicCinemaEvent(input.id, input.student.id);
  if (event.state === "REPLAY") throw new CampusEngineError("INVALID_STATE", "RSVP has closed because this event has ended.", 409);
  const stamp = new Date().toISOString();
  if (!input.going) {
    const entered = rowsToObjects(await turso("SELECT student_id FROM cinema_participants WHERE session_id=? AND student_id=? LIMIT 1", [event.sessionId, input.student.id]))[0];
    if (entered) throw new CampusEngineError("INVALID_STATE", "Your place cannot be cancelled after you enter the event room.", 409);
    const results = await tursoTransaction([
      { sql: "UPDATE cinema_event_rsvps SET status='CANCELLED',updated_at=? WHERE event_id=? AND student_id=? AND status IN ('GOING','WAITLIST')", args: [stamp, event.id, input.student.id] },
      ...(event.format === "SCREENING" ? [] : [{ sql: `UPDATE cinema_event_rsvps SET status='GOING',updated_at=?
        WHERE event_id=? AND status='WAITLIST' AND student_id=(SELECT student_id FROM cinema_event_rsvps
          WHERE event_id=? AND status='WAITLIST' ORDER BY created_at,student_id LIMIT 1)
          AND (SELECT COUNT(*) FROM cinema_event_rsvps WHERE event_id=? AND status='GOING') < (SELECT capacity FROM cinema_events WHERE id=?) RETURNING student_id`, args: [stamp, event.id, event.id, event.id, event.id] }]),
    ]);
    const promotedId = results[1] ? String(rowsToObjects(results[1])[0]?.student_id || "") : "";
    if (promotedId) {
      try {
        const promoted = rowsToObjects(await turso("SELECT email FROM student_accounts WHERE id=? LIMIT 1", [promotedId]))[0];
        if (promoted?.email) {
          await ensureNotificationsTable();
          await queueNotification(turso, { recipient: String(promoted.email), template: "cinema_event_rsvp", subject: `A place opened for ${event.title}`, message: `Your waitlist place is now confirmed. Open /cinema/events/${event.slug} to join when the event starts.`, reference: `cinema-event-promoted:${event.id}:${promotedId}`, nowIso: stamp });
        }
      } catch { /* Promotion remains valid when notification delivery is unavailable. */ }
    }
    return readPublicCinemaEvent(event.id, input.student.id);
  }
  if (event.format !== "SCREENING") {
    // BEGIN IMMEDIATE serializes competing RSVPs. The host's limit is enforced
    // in the write itself; nobody can bypass it through simultaneous requests.
    await tursoTransaction([{ sql: `INSERT INTO cinema_event_rsvps(event_id,student_id,status,created_at,updated_at)
      SELECT ?,?,CASE WHEN (SELECT COUNT(*) FROM cinema_event_rsvps WHERE event_id=? AND status='GOING') < (SELECT capacity FROM cinema_events WHERE id=?) THEN 'GOING' ELSE 'WAITLIST' END,?,?
      ON CONFLICT(event_id,student_id) DO UPDATE SET status=CASE WHEN cinema_event_rsvps.status='GOING' THEN 'GOING' ELSE excluded.status END,
        created_at=CASE WHEN cinema_event_rsvps.status='CANCELLED' THEN excluded.created_at ELSE cinema_event_rsvps.created_at END,updated_at=excluded.updated_at`, args: [event.id, input.student.id, event.id, event.id, stamp, stamp] }]);
    const updated = await readPublicCinemaEvent(event.id, input.student.id);
    if (updated.viewerRsvp === "GOING") {
      try {
        await ensureNotificationsTable();
        await queueNotification(turso, { recipient: input.student.email, template: "cinema_event_rsvp", subject: `You are going to ${event.title}`, message: `${event.organizer.name} saved your place. Open /cinema/events/${event.slug} for event details and the room link.`, reference: `cinema-event:${event.id}:${input.student.id}`, nowIso: stamp });
      } catch { /* The reservation remains durable when notification delivery fails. */ }
    }
    return updated;
  }
  const [result] = await tursoTransaction([{ sql: `INSERT INTO cinema_event_rsvps(event_id,student_id,status,created_at,updated_at)
    SELECT ?,?,'GOING',?,? WHERE EXISTS(SELECT 1 FROM cinema_event_rsvps WHERE event_id=? AND student_id=? AND status='GOING') OR (SELECT capacity FROM cinema_events WHERE id=?)=0 OR
      (SELECT COUNT(*) FROM cinema_event_rsvps WHERE event_id=? AND status='GOING') < (SELECT capacity FROM cinema_events WHERE id=?)
    ON CONFLICT(event_id,student_id) DO UPDATE SET status='GOING',updated_at=excluded.updated_at`, args: [event.id, input.student.id, stamp, stamp, event.id, input.student.id, event.id, event.id, event.id] }]);
  if (Number(result?.affected_row_count || 0) === 0) throw new CampusEngineError("CONFLICT", "This event has reached its attendance limit.", 409);
  try {
    await ensureNotificationsTable();
    await queueNotification(turso, { recipient: input.student.email, template: "cinema_event_rsvp", subject: `You are going to ${event.title}`, message: `${event.organizer.name} saved your place. Open /cinema/events/${event.slug} for event details and the room link.`, reference: `cinema-event:${event.id}:${input.student.id}`, nowIso: stamp });
  } catch { /* The durable RSVP remains useful if email delivery is unavailable. */ }
  return readPublicCinemaEvent(event.id, input.student.id);
}

export async function submitCinemaEventFeedback(input: { id: string; studentId: string; rating: unknown; comment?: unknown }) {
  await requireRuntime();
  const event = await readPublicCinemaEvent(input.id, input.studentId);
  if (event.state !== "REPLAY") throw new CampusEngineError("INVALID_STATE", "Feedback opens after the event ends.", 409);
  const record = await attendanceForCinemaEvent(event.id, input.studentId);
  if (!record.attended) throw new CampusEngineError("FORBIDDEN", "Feedback is available to students who attended the event.", 403);
  const rating = Math.round(Number(input.rating)); if (rating < 1 || rating > 5) throw new CampusEngineError("VALIDATION_ERROR", "Choose a rating from one to five.", 400);
  const stamp = new Date().toISOString();
  await turso(`INSERT INTO cinema_event_feedback(event_id,student_id,rating,comment,created_at,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(event_id,student_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,updated_at=excluded.updated_at`, [event.id, input.studentId, rating, cleanText(input.comment, 600), stamp, stamp]);
  return readPublicCinemaEvent(event.id, input.studentId);
}

export async function attendanceForCinemaEvent(id: string, studentId: string) {
  const event = await readPublicCinemaEvent(id, studentId);
  const attended = rowsToObjects(await turso("SELECT display_name,joined_at,last_seen_at,attendance_seconds FROM cinema_participants WHERE session_id=? AND student_id=? LIMIT 1", [event.sessionId, studentId]))[0];
  const durationSeconds = Math.max(0, (Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 1000);
  const requiredSeconds = Math.min(30 * 60, Math.max(10 * 60, Math.ceil(durationSeconds * 0.5)));
  const presentDuringEvent = Boolean(attended) && Number(attended.attendance_seconds || 0) >= requiredSeconds;
  return { event, attended: presentDuringEvent, displayName: String(attended?.display_name || ""), joinedAt: String(attended?.joined_at || "") };
}

export async function uploadCinemaEventPoster(input: { id: string; studentId: string; body: ArrayBuffer; contentType: string }) {
  await requireRuntime(); const event = await readPublicCinemaEvent(input.id, input.studentId);
  if (!event.canManage) throw new CampusEngineError("FORBIDDEN", "Only the event organizer can change its poster.", 403);
  if (!['image/jpeg','image/png','image/webp'].includes(input.contentType)) throw new CampusEngineError("VALIDATION_ERROR", "Use a JPG, PNG, or WebP poster.", 400);
  if (!input.body.byteLength || input.body.byteLength > 6 * 1024 * 1024) throw new CampusEngineError("VALIDATION_ERROR", "The poster must be smaller than 6 MB.", 400);
  const bytes = new Uint8Array(input.body);
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte);
  const webp = bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!(input.contentType === "image/jpeg" && jpeg || input.contentType === "image/png" && png || input.contentType === "image/webp" && webp)) {
    throw new CampusEngineError("VALIDATION_ERROR", "The poster file does not match its image format.", 400);
  }
  const bucket = await privateBucket(); if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Poster storage is not configured.", 503);
  const key = `cinema/events/${event.id}/poster`; await bucket.put(key, input.body, { httpMetadata: { contentType: input.contentType } });
  await turso("UPDATE cinema_events SET poster_key=?,poster_content_type=?,updated_at=? WHERE id=?", [key, input.contentType, new Date().toISOString(), event.id]);
  return readPublicCinemaEvent(event.id, input.studentId);
}

export async function cinemaEventPoster(id: string) {
  await requireRuntime();
  const row = rowsToObjects(await turso("SELECT poster_key,poster_content_type FROM cinema_events WHERE id=? AND status='PUBLISHED' LIMIT 1", [id]))[0];
  if (!row?.poster_key) throw new CampusEngineError("NOT_FOUND", "This event does not have a poster.", 404);
  const bucket = await privateBucket(); if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Poster storage is not configured.", 503);
  const object = await bucket.get(String(row.poster_key)) as { body?: ReadableStream; httpEtag?: string } | null;
  if (!object?.body) throw new CampusEngineError("NOT_FOUND", "This event poster was not found.", 404);
  return { body: object.body, contentType: String(row.poster_content_type || "image/webp"), etag: String(object.httpEtag || "") };
}
