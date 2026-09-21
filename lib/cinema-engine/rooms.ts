import { CampusEngineError } from "@/lib/campus-engine/errors";
import { closeCinemaRoom, removeCinemaMemberFromRoom, scheduleCinemaRoom } from "@/lib/cinema-engine/realtime";
import {
  CINEMA_DURATION_MAX_MINUTES,
  CINEMA_DURATION_MIN_MINUTES,
  CINEMA_START_MAX_MINUTES,
  hasSchedule,
  markCinemaRoomEnded,
  markCinemaRoomLive,
  parseDurationMinutes,
  parseStartInMinutes,
  scheduleFromNow,
} from "@/lib/cinema-engine/schedule";
import { parseYouTubeId } from "@/lib/cinema-engine/youtube";
import { consoleAudit } from "@/lib/console-audit";
import { incrementMetric, logEvent } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Cinema rooms: the phase-one half of docs/Cinema.
 *
 * A room is a row, its membership is another row, and both are readable by any
 * signed-in student who holds the link. There is no playback state here and no
 * video object: the Durable Object that owns live state arrives with M2, and
 * uploads with phase two. What this module owns is who may be in a room, what
 * state the room itself is in, and the rules that keep both honest.
 *
 * The host is a `student_accounts` row, never a second identity: creating a
 * room joins it, which is also why the host's display name lives in the
 * membership row rather than being joined in from the account on every read.
 */

export const CINEMA_SCHEMA_VERSION = "034_cinema_scheduled_rooms";

export const CINEMA_ROOM_STATUSES = ["CREATED", "LIVE", "ENDED", "EXPIRED", "DELETED"] as const;
export type CinemaRoomStatus = (typeof CINEMA_ROOM_STATUSES)[number];

export const CINEMA_SOURCE_TYPES = ["YOUTUBE", "UPLOAD"] as const;
export type CinemaSourceType = (typeof CINEMA_SOURCE_TYPES)[number];

export const CINEMA_ROOM_VISIBILITIES = ["PUBLIC", "PRIVATE"] as const;
export type CinemaRoomVisibility = (typeof CINEMA_ROOM_VISIBILITIES)[number];

/** Long enough for a topic, short enough for a card and a share message. */
export const CINEMA_TITLE_MAX = 80;

/** How many rooms the lobby lists, and how many members a read returns. */
const LIST_LIMIT = 20;
const PARTICIPANT_LIMIT = 200;

const CINEMA_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cinema_sessions (
    id TEXT PRIMARY KEY,
    host_student_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    video_source_type TEXT NOT NULL DEFAULT 'YOUTUBE',
    video_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'CREATED',
    join_locked INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'PUBLIC',
    started_at TEXT NOT NULL DEFAULT '',
    ended_at TEXT NOT NULL DEFAULT '',
    expired_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_sessions_host ON cinema_sessions(host_student_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_sessions_due ON cinema_sessions(status, ended_at)`,
  `CREATE TABLE IF NOT EXISTS cinema_participants (
    session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    joined_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT '',
    left_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, student_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_participants_session ON cinema_participants(session_id, joined_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_participants_student ON cinema_participants(student_id, joined_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cinema_room_invites (
    session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    invited_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, student_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_room_invites_student ON cinema_room_invites(student_id, created_at DESC)`,
  // Last, because a database created from the statement above already has the
  // column and `runSchemaPass` tolerates exactly this duplicate-column reply.
  `ALTER TABLE cinema_sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PUBLIC'`,
  // M12: the host's clock. `starts_at` is the schedule, never the actual start
  // — that is `started_at` — and an empty pair keeps every room made before
  // this column existed behaving exactly as it did.
  `ALTER TABLE cinema_sessions ADD COLUMN starts_at TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE cinema_sessions ADD COLUMN ends_at TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE cinema_sessions ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 0`,
];

let cinemaTablesReady: Promise<void> | null = null;

/** Memoised per isolate: the room surfaces must not run DDL per request. */
export function ensureCinemaTables() {
  cinemaTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaFoundation",
    version: CINEMA_SCHEMA_VERSION,
    statements: CINEMA_SCHEMA_STATEMENTS,
  }).catch((error: unknown) => {
    cinemaTablesReady = null;
    throw error;
  });
  return cinemaTablesReady;
}

export type CinemaRoomRow = Record<string, unknown>;

export type CinemaParticipant = {
  studentId: string;
  displayName: string;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string;
};

export type CinemaRoom = {
  id: string;
  hostStudentId: string;
  hostName: string;
  title: string;
  sourceType: CinemaSourceType;
  videoId: string;
  status: CinemaRoomStatus;
  joinLocked: boolean;
  visibility: CinemaRoomVisibility;
  isPrivate: boolean;
  isHost: boolean;
  isMember: boolean;
  /** When the host scheduled the room to go live, or '' for a room with no clock. */
  startsAt: string;
  /** When the host's run time ends the room, or '' when only the host ends it. */
  endsAt: string;
  /** The host's chosen run time in minutes; 0 means "until I end it". */
  durationMinutes: number;
  /** Whether this student holds an invitation to a private room. */
  invited: boolean;
  /** Whether a student who is not a member yet may join right now. */
  joinable: boolean;
  verifiedCount: number;
  participants: CinemaParticipant[];
  startedAt: string;
  endedAt: string;
  createdAt: string;
  updatedAt: string;
};

/** A room is playable while it is open or live; everything else is history. */
export function isRoomActive(status: unknown): boolean {
  const value = String(status || "");
  return value === "CREATED" || value === "LIVE";
}

/** The statuses a shared link still resolves to. Ended rooms explain themselves. */
export function isRoomVisible(status: unknown): boolean {
  const value = String(status || "");
  return value === "CREATED" || value === "LIVE" || value === "ENDED";
}

function roomTitle(value: unknown): string {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, CINEMA_TITLE_MAX);
  return cleaned || "Study room";
}

function participantView(row: CinemaRoomRow): CinemaParticipant {
  return {
    studentId: String(row.student_id || ""),
    displayName: String(row.display_name || ""),
    joinedAt: String(row.joined_at || ""),
    lastSeenAt: String(row.last_seen_at || ""),
    leftAt: String(row.left_at || ""),
  };
}

/**
 * One room as a student sees it. Membership is an argument rather than a second
 * query, because every caller already had to know it to get here.
 */
export function roomView(row: CinemaRoomRow, input: { studentId?: string; participants?: CinemaRoomRow[]; memberCount?: number; invited?: boolean } = {}): CinemaRoom {
  const participants = (input.participants || []).map(participantView);
  const studentId = String(input.studentId || "");
  const hostStudentId = String(row.host_student_id || "");
  // The host is a member of their own room even if a membership row is somehow
  // missing: refusing them their own controls would be the worse failure.
  const isMember = Boolean(studentId)
    && (studentId === hostStudentId || participants.some((member) => member.studentId === studentId));
  const host = participants.find((member) => member.studentId === hostStudentId);
  const status = String(row.status || "CREATED") as CinemaRoomStatus;
  const joinLocked = Number(row.join_locked || 0) === 1;
  const visibility = (String(row.visibility || "PUBLIC").toUpperCase() === "PRIVATE" ? "PRIVATE" : "PUBLIC") as CinemaRoomVisibility;
  const isPrivate = visibility === "PRIVATE";
  const invited = input.invited === true;
  return {
    id: String(row.id || ""),
    hostStudentId,
    hostName: host?.displayName || "The host",
    title: String(row.title || "") || "Study room",
    sourceType: (String(row.video_source_type || "YOUTUBE") as CinemaSourceType),
    videoId: String(row.video_id || ""),
    status,
    joinLocked,
    visibility,
    isPrivate,
    isHost: Boolean(studentId) && studentId === hostStudentId,
    isMember,
    invited,
    // Two doors, and a guest has to open both: the host's lock is a door in
    // its own right, so an invitation never walks past it.
    joinable: isRoomActive(status) && (isMember || (!joinLocked && (invited || !isPrivate))),
    verifiedCount: input.memberCount ?? participants.filter((member) => !member.leftAt).length,
    participants,
    startsAt: String(row.starts_at || ""),
    endsAt: String(row.ends_at || ""),
    durationMinutes: Math.max(0, Number(row.duration_minutes || 0)),
    startedAt: String(row.started_at || ""),
    endedAt: String(row.ended_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

const ROOM_COLUMNS = "id,host_student_id,title,video_source_type,video_id,status,join_locked,visibility,starts_at,ends_at,duration_minutes,started_at,ended_at,created_at,updated_at";

async function membersOf(sessionIds: string[]): Promise<Map<string, CinemaRoomRow[]>> {
  const grouped = new Map<string, CinemaRoomRow[]>();
  if (!sessionIds.length) return grouped;
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = rowsToObjects(await turso(
    `SELECT session_id,student_id,display_name,joined_at,last_seen_at,left_at FROM cinema_participants
      WHERE session_id IN (${placeholders}) ORDER BY joined_at ASC LIMIT ${PARTICIPANT_LIMIT}`,
    sessionIds,
  ));
  for (const row of rows) {
    const key = String(row.session_id || "");
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  return grouped;
}

/**
 * Counts only, for the lobby. A list of twenty rooms does not need twenty
 * member lists to show a number, and one query cannot be starved by a chatty
 * room the way a single shared row limit could.
 */
async function memberCounts(sessionIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!sessionIds.length) return counts;
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = rowsToObjects(await turso(
    `SELECT session_id, COUNT(*) AS members FROM cinema_participants
      WHERE session_id IN (${placeholders}) AND left_at = '' GROUP BY session_id`,
    sessionIds,
  ));
  for (const row of rows) counts.set(String(row.session_id || ""), Number(row.members || 0));
  return counts;
}

/** A private room, without a second read: the column is on every room row. */
function isPrivateRow(row: CinemaRoomRow): boolean {
  return String(row.visibility || "PUBLIC").toUpperCase() === "PRIVATE";
}

/** Whether one student holds an invitation to one room. */
async function isInvited(sessionId: string, studentId: string): Promise<boolean> {
  const student = String(studentId || "");
  if (!student) return false;
  const rows = rowsToObjects(await turso(
    "SELECT student_id FROM cinema_room_invites WHERE session_id = ? AND student_id = ? LIMIT 1",
    [String(sessionId), student],
  ));
  return rows.length > 0;
}

async function roomRow(sessionId: string): Promise<CinemaRoomRow | undefined> {
  return rowsToObjects(await turso(
    `SELECT ${ROOM_COLUMNS} FROM cinema_sessions WHERE id = ? LIMIT 1`,
    [sessionId],
  ))[0];
}

/** A room that must exist and still resolve for the caller, or a 404. */
async function requireVisibleRoom(sessionId: string) {
  const id = String(sessionId || "").trim();
  if (!id) throw new CampusEngineError("NOT_FOUND", "That room does not exist.", 404);
  let row = await roomRow(id);
  if (!row || !isRoomVisible(row.status)) throw new CampusEngineError("NOT_FOUND", "That room does not exist.", 404);
  // A room can be read before its alarm rings — or after a deployment that
  // never armed one — so the clock is reconciled here, where every surface
  // already passes. The UPDATEs are conditional: whoever arrives second is a
  // no-op, and a room the host opened early is left exactly as it is.
  if (await reconcileRoomClock(row)) row = (await roomRow(id)) || row;
  return row;
}

/**
 * Moves a room whose minute has arrived, and only that room: CREATED past its
 * `starts_at` becomes LIVE, anything past `ends_at` becomes ENDED. The row's
 * own ISO strings compare as text, which is why the schedule stores UTC.
 */
async function reconcileRoomClock(row: CinemaRoomRow): Promise<boolean> {
  const status = String(row.status || "");
  if (!isRoomActive(status)) return false;
  const now = Date.now();
  const endsAt = String(row.ends_at || "");
  if (endsAt && Date.parse(endsAt) <= now) return markCinemaRoomEnded(String(row.id || ""), now);
  const startsAt = String(row.starts_at || "");
  if (status === "CREATED" && startsAt && Date.parse(startsAt) <= now) {
    return markCinemaRoomLive(String(row.id || ""), Date.parse(startsAt));
  }
  return false;
}

/**
 * Creating a room also joins it: the host is a participant from the first
 * second, which is what makes "who is here" a single source of truth.
 *
 * The two choices a room is made of are made here, once, because the room
 * itself carries neither control: where the video comes from — a YouTube link,
 * or a file the host uploads from the lobby next — and who may walk in. An
 * upload room is created private and empty on purpose: the door is shut before
 * the first byte arrives, and `video_id` is filled by the upload that follows.
 */
export async function createRoom(input: {
  student: { id: string; name?: string };
  title?: unknown;
  video?: unknown;
  source?: unknown;
  visibility?: unknown;
  /** Minutes from now the room goes live; absent keeps the legacy CREATED room. */
  startInMinutes?: unknown;
  /** The host's run time in minutes; 0 or absent means "until I end it". */
  durationMinutes?: unknown;
}) {
  await requireTurso();
  await ensureCinemaTables();
  const source = String(input.source ?? "YOUTUBE").trim().toUpperCase();
  if (!(CINEMA_SOURCE_TYPES as readonly string[]).includes(source)) {
    throw new CampusEngineError("VALIDATION_ERROR", "That is not a video source a room understands.", 400);
  }
  // A YouTube room needs its video now; an upload room gets its file from the
  // lobby, so it is created with nothing attached yet.
  let videoId = "";
  if (source === "YOUTUBE") {
    const lookup = parseYouTubeId(input.video);
    if (!lookup.ok) throw new CampusEngineError("VALIDATION_ERROR", lookup.reason, 400);
    videoId = lookup.id;
  }
  // A file can never open the door it will close: the upload rule wins over
  // whatever the caller asked for.
  const visibility: CinemaRoomVisibility = source === "UPLOAD" || String(input.visibility ?? "").trim().toUpperCase() === "PRIVATE"
    ? "PRIVATE"
    : "PUBLIC";

  // The clock is optional: a create call that mentions neither a start nor a
  // run time keeps the room this engine has always made — CREATED, waiting for
  // the host to open it. A room with a start of "now" is live before the first
  // socket, which is what lets the lobby's default room play on arrival.
  const duration = parseDurationMinutes(input.durationMinutes);
  if (duration === null) {
    throw new CampusEngineError(
      "VALIDATION_ERROR",
      `A room runs for ${CINEMA_DURATION_MIN_MINUTES} minutes to ${CINEMA_DURATION_MAX_MINUTES / 60} hours, or until the host ends it.`,
      400,
    );
  }
  const clocked = hasSchedule(input.startInMinutes) || duration > 0;
  const startIn = clocked ? parseStartInMinutes(input.startInMinutes ?? 0) : 0;
  if (startIn === null) {
    throw new CampusEngineError(
      "VALIDATION_ERROR",
      `A room can start now or up to ${CINEMA_START_MAX_MINUTES / (24 * 60)} days from now.`,
      400,
    );
  }
  const now = Date.now();
  const { startsAt, endsAt } = clocked ? scheduleFromNow(startIn, duration, now) : { startsAt: "", endsAt: "" };
  const goesLive = clocked && startIn === 0;
  const stamp = new Date(now).toISOString();
  const status: CinemaRoomStatus = goesLive ? "LIVE" : "CREATED";
  const id = crypto.randomUUID();
  const title = roomTitle(input.title);
  await turso(
    `INSERT INTO cinema_sessions (id,host_student_id,title,video_source_type,video_id,status,visibility,starts_at,ends_at,duration_minutes,started_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, String(input.student.id), title, source, videoId, status, visibility, startsAt, endsAt, duration, goesLive ? stamp : "", stamp, stamp],
  );
  try {
    await turso(
      "INSERT OR IGNORE INTO cinema_participants (session_id,student_id,display_name,joined_at,last_seen_at,left_at) VALUES (?,?,?,?,?,'')",
      [id, String(input.student.id), String(input.student.name || "").slice(0, 80), stamp, stamp],
    );
  } catch (error) {
    // A room without its host is a share link nobody can open, so the insert
    // that failed takes the room with it rather than leaving it behind.
    await turso("DELETE FROM cinema_sessions WHERE id = ?", [id]).catch(() => undefined);
    throw error;
  }
  logEvent("info", "cinema_room_created", { roomId: id, source, visibility, scheduled: clocked, startInMinutes: clocked ? startIn : 0, durationMinutes: duration });
  await incrementMetric("cinema_rooms_created");
  // The row is the truth; the room's object is the alarm clock. Best-effort
  // like every other nudge, because a deployment without the binding still
  // promotes a due room the moment anybody reads it.
  if (clocked) {
    await scheduleCinemaRoom(id, {
      hostStudentId: String(input.student.id),
      title,
      sourceType: source,
      videoId,
      startsAt,
      endsAt,
    });
  }
  return roomView(
    (await roomRow(id)) || {},
    { studentId: input.student.id, participants: (await membersOf([id])).get(id) || [] },
  );
}

export async function readRoom(input: { id: string; studentId?: string }) {
  await requireTurso();
  await ensureCinemaTables();
  const row = await requireVisibleRoom(input.id);
  const members = (await membersOf([String(row.id)])).get(String(row.id)) || [];
  const studentId = String(input.studentId || "");
  const isMember = Boolean(studentId) && (studentId === String(row.host_student_id || "")
    || members.some((member) => String(member.student_id || "") === studentId));
  const invited = isPrivateRow(row) && !isMember
    ? await isInvited(String(row.id), studentId)
    : false;
  // A private room is readable only by its members and its guest list. The
  // refusal is a 403 rather than the usual 404, because the host shared the
  // link before the door closed and "private" is the honest answer.
  if (isPrivateRow(row) && !isMember && !invited) {
    throw new CampusEngineError("FORBIDDEN", "This room is private. Ask the host for an invite.", 403);
  }
  return roomView(row, { studentId: input.studentId, participants: members, invited });
}

/** The lobby: rooms this student hosts or has joined, newest first. */
export async function listMyRooms(studentId: string) {
  await requireTurso();
  await ensureCinemaTables();
  const rows = rowsToObjects(await turso(
    `SELECT s.id,s.host_student_id,s.title,s.video_source_type,s.video_id,s.status,s.join_locked,s.visibility,
            CASE WHEN i.student_id IS NULL THEN 0 ELSE 1 END AS invited,
            s.starts_at,s.ends_at,s.duration_minutes,s.started_at,s.ended_at,s.created_at,s.updated_at
       FROM cinema_sessions s
       LEFT JOIN cinema_participants p ON p.session_id = s.id AND p.student_id = ?
       LEFT JOIN cinema_room_invites i ON i.session_id = s.id AND i.student_id = ?
      WHERE s.status <> 'DELETED' AND (p.student_id IS NOT NULL OR i.student_id IS NOT NULL)
      ORDER BY s.created_at DESC LIMIT ${LIST_LIMIT}`,
    [String(studentId), String(studentId)],
  ));
  const counts = await memberCounts(rows.map((row) => String(row.id || "")));
  // Every room here is in the list because this student joined it or was
  // invited to it, so the names are not needed to render the lobby — only the
  // count, which the grouped query already returned.
  return rows.map((row) => roomView(row, {
    studentId,
    participants: [],
    memberCount: counts.get(String(row.id || "")) ?? 0,
    invited: Number(row.invited || 0) === 1,
  }));
}

/**
 * Joining is idempotent and never moves the join time: a student who reloads
 * three times joined once. A locked room stays open to its existing members,
 * which is what makes the lock a door rather than a lockout.
 */
export async function joinRoom(input: { id: string; student: { id: string; name?: string } }) {
  await requireTurso();
  await ensureCinemaTables();
  const studentId = String(input.student.id);
  const row = await requireVisibleRoom(input.id);
  const members = (await membersOf([String(row.id)])).get(String(row.id)) || [];
  const isMember = members.some((member) => String(member.student_id || "") === studentId);
  let invited = false;

  // An ended room admits nobody, member or not: the page says the room has
  // ended, and a join that quietly succeeded would contradict it.
  if (!isRoomActive(row.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  if (!isMember) {
    // Two doors, both of which a guest has to open: the lock the host set and
    // the guest list of a private room. Neither replaces the other.
    if (Number(row.join_locked || 0) === 1) throw new CampusEngineError("FORBIDDEN", "The host has locked this room.", 403);
    if (isPrivateRow(row)) {
      invited = await isInvited(String(row.id), studentId);
      if (!invited) throw new CampusEngineError("FORBIDDEN", "This room is private. Ask the host for an invite.", 403);
    }
    const stamp = new Date().toISOString();
    await turso(
      "INSERT OR IGNORE INTO cinema_participants (session_id,student_id,display_name,joined_at,last_seen_at,left_at) VALUES (?,?,?,?,?,'')",
      [String(row.id), studentId, String(input.student.name || "").slice(0, 80), stamp, stamp],
    );
    logEvent("info", "cinema_room_joined", { roomId: String(row.id) });
    await incrementMetric("cinema_rooms_joined");
  } else {
    await turso(
      "UPDATE cinema_participants SET last_seen_at = ?, left_at = '' WHERE session_id = ? AND student_id = ?",
      [new Date().toISOString(), String(row.id), studentId],
    );
  }

  const fresh = (await membersOf([String(row.id)])).get(String(row.id)) || [];
  return roomView((await roomRow(String(row.id))) || row, { studentId, participants: fresh, invited });
}

export const CINEMA_ROOM_ACTIONS = ["OPEN", "END", "LOCK", "UNLOCK", "RETITLE", "PRIVATE", "PUBLIC"] as const;
export type CinemaRoomAction = (typeof CINEMA_ROOM_ACTIONS)[number];

/**
 * Host-only state changes. Each action is one conditional UPDATE, so two tabs
 * cannot both open a room or both end it and disagree about what happened.
 */
export async function patchRoom(input: { id: string; studentId: string; action: unknown; title?: unknown }) {
  await requireTurso();
  await ensureCinemaTables();
  const action = String(input.action || "").trim().toUpperCase() as CinemaRoomAction;
  if (!CINEMA_ROOM_ACTIONS.includes(action)) {
    throw new CampusEngineError("VALIDATION_ERROR", "That action is not one a room understands.", 400);
  }
  const row = await requireVisibleRoom(input.id);
  if (String(row.host_student_id || "") !== String(input.studentId || "")) {
    throw new CampusEngineError("FORBIDDEN", "Only the host can change this room.", 403);
  }
  const stamp = new Date().toISOString();
  const id = String(row.id);

  if (action === "OPEN") {
    if (!isRoomActive(row.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
    // A room with a run time gains its end when it actually opens: a host who
    // starts their 19:00 room at 18:40 still gets the full run.
    const runMinutes = Math.max(0, Number(row.duration_minutes || 0));
    const endsAt = runMinutes > 0 ? new Date(Date.now() + runMinutes * 60_000).toISOString() : "";
    const wasCreated = String(row.status || "") === "CREATED";
    await turso(
      wasCreated
        ? "UPDATE cinema_sessions SET status = 'LIVE', started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, starts_at = '', ends_at = CASE WHEN ? > 0 THEN ? ELSE ends_at END, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')"
        : "UPDATE cinema_sessions SET status = 'LIVE', started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
      wasCreated ? [stamp, runMinutes, endsAt, stamp, id] : [stamp, stamp, id],
    );
    if (wasCreated) {
      // The object's start alarm is moot now that the host is here; its end
      // alarm is not, and a room with no run time clears both.
      await scheduleCinemaRoom(id, {
        hostStudentId: String(row.host_student_id || ""),
        title: String(row.title || ""),
        sourceType: String(row.video_source_type || "YOUTUBE"),
        videoId: String(row.video_id || ""),
        startsAt: "",
        endsAt,
      });
    }
  } else if (action === "END") {
    await turso(
      "UPDATE cinema_sessions SET status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
      [stamp, stamp, id],
    );
    // The live object holds the sockets; the row cannot close them by itself.
    await closeCinemaRoom(id);
    logEvent("info", "cinema_room_ended", { roomId: id });
    await incrementMetric("cinema_rooms_ended");
  } else if (action === "LOCK" || action === "UNLOCK") {
    await turso(
      "UPDATE cinema_sessions SET join_locked = ?, updated_at = ? WHERE id = ?",
      [action === "LOCK" ? 1 : 0, stamp, id],
    );
  } else if (action === "PRIVATE" || action === "PUBLIC") {
    // Changing the door does not move anyone already inside: a member keeps
    // their seat, and only the people outside it changes.
    await turso(
      "UPDATE cinema_sessions SET visibility = ?, updated_at = ? WHERE id = ?",
      [action === "PRIVATE" ? "PRIVATE" : "PUBLIC", stamp, id],
    );
    logEvent("info", action === "PRIVATE" ? "cinema_room_made_private" : "cinema_room_made_public", { roomId: id });
  } else {
    await turso(
      "UPDATE cinema_sessions SET title = ?, updated_at = ? WHERE id = ?",
      [roomTitle(input.title), stamp, id],
    );
  }

  const fresh = (await membersOf([id])).get(id) || [];
  return roomView((await roomRow(id)) || row, { studentId: input.studentId, participants: fresh });
}

/** The guest list is bounded like every other list in the room. */
const INVITE_LIMIT = 60;
/** Only a UMaT student address can be invited, and only one that exists. */
const UMAT_STUDENT_EMAIL = /^[A-Za-z0-9._%+-]+@st\.umat\.edu\.gh$/;

export type CinemaRoomInvite = {
  studentId: string;
  email: string;
  name: string;
  createdAt: string;
};

async function requireHostedRoom(sessionId: string, studentId: string) {
  const row = await requireVisibleRoom(sessionId);
  if (String(row.host_student_id || "") !== String(studentId || "")) {
    throw new CampusEngineError("FORBIDDEN", "Only the host can manage this room's guest list.", 403);
  }
  return row;
}

async function inviteRows(sessionId: string): Promise<CinemaRoomInvite[]> {
  const rows = rowsToObjects(await turso(
    `SELECT i.student_id,COALESCE(a.email,'') AS email,COALESCE(a.name,'') AS name,i.created_at
       FROM cinema_room_invites i
       LEFT JOIN student_accounts a ON a.id = i.student_id
      WHERE i.session_id = ?
      ORDER BY i.created_at ASC LIMIT ${INVITE_LIMIT}`,
    [String(sessionId)],
  ));
  return rows.map((row) => ({
    studentId: String(row.student_id || ""),
    email: String(row.email || ""),
    name: String(row.name || ""),
    createdAt: String(row.created_at || ""),
  }));
}

/** The host's guest list: who may walk into a private room. */
export async function listRoomInvites(input: { id: string; studentId: string }) {
  await requireTurso();
  await ensureCinemaTables();
  const row = await requireHostedRoom(input.id, input.studentId);
  return { invites: await inviteRows(String(row.id)) };
}

/**
 * An invitation is an address, never an id typed in by hand: the host gives a
 * UMaT email, the account is looked up, and a student who has no account is a
 * 404 rather than a row that would never be read.
 */
export async function inviteToRoom(input: { id: string; studentId: string; email: unknown }) {
  await requireTurso();
  await ensureCinemaTables();
  const row = await requireHostedRoom(input.id, input.studentId);
  if (!isRoomActive(row.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  const email = String(input.email ?? "").replace(/\s+/g, "").toLowerCase();
  if (!UMAT_STUDENT_EMAIL.test(email)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Invite a UMaT student address ending in @st.umat.edu.gh.", 400);
  }
  const account = rowsToObjects(await turso(
    "SELECT id,COALESCE(name,'') AS name FROM student_accounts WHERE lower(email) = ? AND COALESCE(active,1) = 1 LIMIT 1",
    [email],
  ))[0];
  if (!account) throw new CampusEngineError("NOT_FOUND", "No active UMaT account uses that address. Check the spelling with the student.", 404);
  const inviteeId = String(account.id || "");
  if (inviteeId === String(input.studentId)) {
    throw new CampusEngineError("VALIDATION_ERROR", "You are already in this room.", 400);
  }
  const stamp = new Date().toISOString();
  await turso(
    "INSERT OR IGNORE INTO cinema_room_invites (session_id,student_id,invited_by,created_at) VALUES (?,?,?,?)",
    [String(row.id), inviteeId, String(input.studentId), stamp],
  );
  logEvent("info", "cinema_room_invited", { roomId: String(row.id) });
  return {
    invite: { studentId: inviteeId, email, name: String(account.name || ""), createdAt: stamp },
    invites: await inviteRows(String(row.id)),
  };
}

/** Taking an invitation back never removes a member; it only closes the door behind them. */
export async function removeRoomInvite(input: { id: string; studentId: string; inviteeId: unknown }) {
  await requireTurso();
  await ensureCinemaTables();
  const row = await requireHostedRoom(input.id, input.studentId);
  const inviteeId = String(input.inviteeId || "").trim();
  if (!inviteeId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the invitation to take back.", 400);
  const result = await turso(
    "DELETE FROM cinema_room_invites WHERE session_id = ? AND student_id = ?",
    [String(row.id), inviteeId],
  );
  const removed = Number(result.affected_row_count || 0) > 0;
  if (removed) logEvent("info", "cinema_room_invite_removed", { roomId: String(row.id) });
  return { removed, invites: await inviteRows(String(row.id)) };
}

/**
 * The host removes a guest from the room itself.
 *
 * Taking an invitation back closes the door behind someone who has not walked
 * through it; this is for the guest who has: the invitation, the membership
 * and the live socket all go together, so "removed" means the person is out of
 * the room and out of its presence list, not merely uninvited. The host cannot
 * remove themselves — ending the room is the action for that.
 */
export async function removeRoomGuest(input: { id: string; studentId: string; guestId: unknown }) {
  await requireTurso();
  await ensureCinemaTables();
  const row = await requireHostedRoom(input.id, input.studentId);
  const guestId = String(input.guestId || "").trim();
  if (!guestId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the guest to remove.", 400);
  if (guestId === String(input.studentId)) {
    throw new CampusEngineError("VALIDATION_ERROR", "The host is not a guest of their own room. End the room to close it.", 400);
  }
  const invitation = await turso(
    "DELETE FROM cinema_room_invites WHERE session_id = ? AND student_id = ?",
    [String(row.id), guestId],
  );
  const membership = await turso(
    "DELETE FROM cinema_participants WHERE session_id = ? AND student_id = ?",
    [String(row.id), guestId],
  );
  const removedInvitation = Number(invitation.affected_row_count || 0) > 0;
  const removedMembership = Number(membership.affected_row_count || 0) > 0;
  if (removedInvitation || removedMembership) {
    // The row is the truth; closing the sockets is the courtesy that makes the
    // removal immediate for the room and for the person who left.
    await removeCinemaMemberFromRoom(String(row.id), guestId);
    logEvent("info", "cinema_room_guest_removed", { roomId: String(row.id) });
    await incrementMetric("cinema_room_guests_removed");
  }
  return { removed: removedInvitation || removedMembership, invites: await inviteRows(String(row.id)) };
}

export type ConsoleCinemaRoom = {
  id: string;
  title: string;
  hostStudentId: string;
  hostName: string;
  status: CinemaRoomStatus;
  joinLocked: boolean;
  visibility: CinemaRoomVisibility;
  memberCount: number;
  startedAt: string;
  endedAt: string;
  createdAt: string;
  updatedAt: string;
};

const CONSOLE_ROOM_LIMIT = 100;

/**
 * The staff list. It is deliberately not the student lobby: it shows rooms a
 * staff member is not a member of, it may include ended ones, and it carries
 * the host's name so a moderator knows who to talk to. The filter is a closed
 * set, never a caller-supplied SQL fragment.
 */
export async function listRoomsForConsole(input: { status?: unknown; q?: unknown; limit?: number } = {}): Promise<ConsoleCinemaRoom[]> {
  await requireTurso();
  await ensureCinemaTables();
  const wanted = String(input.status || "ACTIVE").trim().toUpperCase();
  const filter = wanted === "ENDED"
    ? "s.status IN ('ENDED','EXPIRED')"
    : wanted === "ALL"
      ? "s.status <> 'DELETED'"
      : "s.status IN ('CREATED','LIVE')";
  const search = String(input.q || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const limit = Math.min(Math.max(Math.round(Number(input.limit) || CONSOLE_ROOM_LIMIT), 1), 200);
  const args: string[] = [];
  let where = filter;
  if (search) {
    where += " AND (s.title LIKE ? OR s.id LIKE ? OR COALESCE(p.display_name,'') LIKE ?)";
    args.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const rows = rowsToObjects(await turso(
    `SELECT s.id,s.host_student_id,s.title,s.status,s.join_locked,s.visibility,s.started_at,s.ended_at,s.created_at,s.updated_at,COALESCE(p.display_name,'') AS host_name
       FROM cinema_sessions s
       LEFT JOIN cinema_participants p ON p.session_id = s.id AND p.student_id = s.host_student_id
      WHERE ${where}
      ORDER BY CASE WHEN s.status IN ('CREATED','LIVE') THEN 0 ELSE 1 END, s.created_at DESC
      LIMIT ${limit}`,
    args,
  ));
  const counts = await memberCounts(rows.map((row) => String(row.id || "")));
  return rows.map((row) => ({
    id: String(row.id || ""),
    title: String(row.title || "") || "Study room",
    hostStudentId: String(row.host_student_id || ""),
    hostName: String(row.host_name || "") || "The host",
    status: String(row.status || "CREATED") as CinemaRoomStatus,
    joinLocked: Number(row.join_locked || 0) === 1,
    visibility: (String(row.visibility || "PUBLIC").toUpperCase() === "PRIVATE" ? "PRIVATE" : "PUBLIC") as CinemaRoomVisibility,
    memberCount: counts.get(String(row.id || "")) ?? 0,
    startedAt: String(row.started_at || ""),
    endedAt: String(row.ended_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  }));
}

/**
 * A moderator ends a room. The same effect as the host's END action, written
 * here because the actor is staff rather than the host and because the console
 * records who did it. The update is conditional, so a room that ended between
 * the read and the write cannot be ended twice.
 */
export async function endRoomAsStaff(input: { roomId: string; actor: string }) {
  await requireTurso();
  await ensureCinemaTables();
  const row = await requireVisibleRoom(input.roomId);
  const id = String(row.id);
  if (!isRoomActive(row.status)) throw new CampusEngineError("INVALID_STATE", "This room is not open.", 409);
  const stamp = new Date().toISOString();
  const result = await turso(
    "UPDATE cinema_sessions SET status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
    [stamp, stamp, id],
  );
  if (!Number(result.affected_row_count || 0)) throw new CampusEngineError("INVALID_STATE", "This room is not open.", 409);
  // The row is the truth; closing the sockets is a courtesy the object performs.
  await closeCinemaRoom(id);
  await consoleAudit({
    actor: input.actor,
    action: "cinema_room_ended",
    targetType: "cinema_session",
    targetReference: id,
    details: { title: String(row.title || ""), hostStudentId: String(row.host_student_id || "") },
  });
  logEvent("info", "cinema_room_ended_by_staff", { roomId: id, actor: input.actor });
  await incrementMetric("cinema_rooms_ended");
  return { id, status: "ENDED" as const, endedAt: stamp };
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}
