import { CampusEngineError } from "@/lib/campus-engine/errors";
import { parseYouTubeId } from "@/lib/cinema-engine/youtube";
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

export const CINEMA_SCHEMA_VERSION = "026_cinema_foundation";

export const CINEMA_ROOM_STATUSES = ["CREATED", "LIVE", "ENDED", "EXPIRED", "DELETED"] as const;
export type CinemaRoomStatus = (typeof CINEMA_ROOM_STATUSES)[number];

export const CINEMA_SOURCE_TYPES = ["YOUTUBE", "UPLOAD"] as const;
export type CinemaSourceType = (typeof CINEMA_SOURCE_TYPES)[number];

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
  isHost: boolean;
  isMember: boolean;
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
export function roomView(row: CinemaRoomRow, input: { studentId?: string; participants?: CinemaRoomRow[]; memberCount?: number } = {}): CinemaRoom {
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
  return {
    id: String(row.id || ""),
    hostStudentId,
    hostName: host?.displayName || "The host",
    title: String(row.title || "") || "Study room",
    sourceType: (String(row.video_source_type || "YOUTUBE") as CinemaSourceType),
    videoId: String(row.video_id || ""),
    status,
    joinLocked,
    isHost: Boolean(studentId) && studentId === hostStudentId,
    isMember,
    joinable: isRoomActive(status) && (!joinLocked || isMember),
    verifiedCount: input.memberCount ?? participants.filter((member) => !member.leftAt).length,
    participants,
    startedAt: String(row.started_at || ""),
    endedAt: String(row.ended_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

const ROOM_COLUMNS = "id,host_student_id,title,video_source_type,video_id,status,join_locked,started_at,ended_at,created_at,updated_at";

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
  const row = await roomRow(id);
  if (!row || !isRoomVisible(row.status)) throw new CampusEngineError("NOT_FOUND", "That room does not exist.", 404);
  return row;
}

/**
 * Creating a room also joins it: the host is a participant from the first
 * second, which is what makes "who is here" a single source of truth.
 */
export async function createRoom(input: { student: { id: string; name?: string }; title?: unknown; video?: unknown }) {
  await requireTurso();
  await ensureCinemaTables();
  const lookup = parseYouTubeId(input.video);
  if (!lookup.ok) throw new CampusEngineError("VALIDATION_ERROR", lookup.reason, 400);

  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  const title = roomTitle(input.title);
  await turso(
    `INSERT INTO cinema_sessions (id,host_student_id,title,video_source_type,video_id,status,created_at,updated_at)
     VALUES (?,?,?,?,?,'CREATED',?,?)`,
    [id, String(input.student.id), title, "YOUTUBE", lookup.id, stamp, stamp],
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
  logEvent("info", "cinema_room_created", { roomId: id });
  await incrementMetric("cinema_rooms_created");
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
  return roomView(row, { studentId: input.studentId, participants: members });
}

/** The lobby: rooms this student hosts or has joined, newest first. */
export async function listMyRooms(studentId: string) {
  await requireTurso();
  await ensureCinemaTables();
  const rows = rowsToObjects(await turso(
    `SELECT s.id,s.host_student_id,s.title,s.video_source_type,s.video_id,s.status,s.join_locked,s.started_at,s.ended_at,s.created_at,s.updated_at
       FROM cinema_sessions s
       JOIN cinema_participants p ON p.session_id = s.id AND p.student_id = ?
      WHERE s.status <> 'DELETED'
      ORDER BY s.created_at DESC LIMIT ${LIST_LIMIT}`,
    [String(studentId)],
  ));
  const counts = await memberCounts(rows.map((row) => String(row.id || "")));
  // Every room here is in the list because this student is in it — that is what
  // the join proved — so the names are not needed to render the lobby.
  return rows.map((row) => roomView(row, {
    studentId,
    participants: [],
    memberCount: counts.get(String(row.id || "")) ?? 0,
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

  // An ended room admits nobody, member or not: the page says the room has
  // ended, and a join that quietly succeeded would contradict it.
  if (!isRoomActive(row.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  if (!isMember) {
    if (Number(row.join_locked || 0) === 1) throw new CampusEngineError("FORBIDDEN", "The host has locked this room.", 403);
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
  return roomView((await roomRow(String(row.id))) || row, { studentId, participants: fresh });
}

export const CINEMA_ROOM_ACTIONS = ["OPEN", "END", "LOCK", "UNLOCK", "RETITLE"] as const;
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
    await turso(
      "UPDATE cinema_sessions SET status = 'LIVE', started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
      [stamp, stamp, id],
    );
  } else if (action === "END") {
    await turso(
      "UPDATE cinema_sessions SET status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('CREATED','LIVE')",
      [stamp, stamp, id],
    );
    logEvent("info", "cinema_room_ended", { roomId: id });
    await incrementMetric("cinema_rooms_ended");
  } else if (action === "LOCK" || action === "UNLOCK") {
    await turso(
      "UPDATE cinema_sessions SET join_locked = ?, updated_at = ? WHERE id = ?",
      [action === "LOCK" ? 1 : 0, stamp, id],
    );
  } else {
    await turso(
      "UPDATE cinema_sessions SET title = ?, updated_at = ? WHERE id = ?",
      [roomTitle(input.title), stamp, id],
    );
  }

  const fresh = (await membersOf([id])).get(id) || [];
  return roomView((await roomRow(id)) || row, { studentId: input.studentId, participants: fresh });
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}
