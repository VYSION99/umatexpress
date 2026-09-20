import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema rooms: creating one joins its host, joining is idempotent, a locked
 * door is a door rather than a lockout, and only the host moves the room on.
 *
 * The engine runs against a fake Turso that keeps both tables in memory, and
 * the fake refuses any statement it was not taught, so a query change shows up
 * as a failing test rather than a silently unasserted write.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-rooms-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const state = { rooms: [], members: [], metrics: new Map() };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });
const affected = (count) => ok({ affected_row_count: count });

const ROOM_COLUMNS = ["id", "host_student_id", "title", "video_source_type", "video_id", "status", "join_locked", "started_at", "ended_at", "created_at", "updated_at"];
const MEMBER_COLUMNS = ["session_id", "student_id", "display_name", "joined_at", "last_seen_at", "left_at"];

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);

  if (/^INSERT INTO metrics_counters/.test(sql)) {
    const [name, day, amount] = args;
    const key = `${name}:${day}`;
    const count = (state.metrics.get(key) || 0) + Number(amount);
    state.metrics.set(key, count);
    return ok(table(["count"], [{ count }]));
  }

  if (/^INSERT INTO cinema_sessions/.test(sql)) {
    const [id, hostStudentId, title, sourceType, videoId, createdAt, updatedAt] = args;
    state.rooms.push({
      id, host_student_id: hostStudentId, title, video_source_type: sourceType, video_id: videoId,
      status: "CREATED", join_locked: 0, started_at: "", ended_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^SELECT id,host_student_id,title,video_source_type,video_id,status,join_locked,started_at,ended_at,created_at,updated_at FROM cinema_sessions WHERE id = \? LIMIT 1/.test(sql)) {
    const row = state.rooms.find((room) => room.id === args[0]);
    return ok(row ? table(ROOM_COLUMNS, [row]) : empty);
  }
  if (/^INSERT OR IGNORE INTO cinema_participants/.test(sql)) {
    const [sessionId, studentId, displayName, joinedAt] = args;
    if (state.members.some((member) => member.session_id === sessionId && member.student_id === studentId)) return affected(0);
    state.members.push({ session_id: sessionId, student_id: studentId, display_name: displayName, joined_at: joinedAt, last_seen_at: joinedAt, left_at: "" });
    return affected(1);
  }
  if (/^SELECT session_id,student_id,display_name,joined_at,last_seen_at,left_at FROM cinema_participants\s+WHERE session_id IN/.test(sql)) {
    const ids = args;
    const rows = state.members
      .filter((member) => ids.includes(member.session_id))
      .sort((left, right) => String(left.joined_at).localeCompare(String(right.joined_at)))
      .slice(0, 200);
    return ok(rows.length ? table(MEMBER_COLUMNS, rows) : empty);
  }
  if (/^UPDATE cinema_participants SET last_seen_at = \?, left_at = '' WHERE session_id = \? AND student_id = \?/.test(sql)) {
    const [lastSeenAt, sessionId, studentId] = args;
    const member = state.members.find((row) => row.session_id === sessionId && row.student_id === studentId);
    if (member) Object.assign(member, { last_seen_at: lastSeenAt, left_at: "" });
    return affected(member ? 1 : 0);
  }
  if (/^UPDATE cinema_sessions SET status = 'LIVE'/.test(sql)) {
    const [startedAt, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (room && (room.status === "CREATED" || room.status === "LIVE")) {
      room.status = "LIVE";
      room.started_at = room.started_at || startedAt;
      room.updated_at = updatedAt;
    }
    return affected(room ? 1 : 0);
  }
  if (/^UPDATE cinema_sessions SET status = 'ENDED'/.test(sql)) {
    const [endedAt, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (room && (room.status === "CREATED" || room.status === "LIVE")) {
      room.status = "ENDED";
      room.ended_at = endedAt;
      room.updated_at = updatedAt;
    }
    return affected(room ? 1 : 0);
  }
  if (/^UPDATE cinema_sessions SET join_locked = \?/.test(sql)) {
    const [locked, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (room) Object.assign(room, { join_locked: Number(locked), updated_at: updatedAt });
    return affected(room ? 1 : 0);
  }
  if (/^UPDATE cinema_sessions SET title = \?/.test(sql)) {
    const [title, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (room) Object.assign(room, { title, updated_at: updatedAt });
    return affected(room ? 1 : 0);
  }
  if (/FROM cinema_sessions s\s+JOIN cinema_participants p/.test(sql)) {
    const studentId = args[0];
    const ids = state.members.filter((member) => member.student_id === studentId).map((member) => member.session_id);
    const rows = state.rooms
      .filter((room) => ids.includes(room.id) && room.status !== "DELETED")
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, 20);
    return ok(rows.length ? table(ROOM_COLUMNS, rows) : empty);
  }

  throw new Error(`Unhandled SQL in the cinema test: ${sql}`);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { parseYouTubeId } = await vite.ssrLoadModule("/lib/cinema-engine/youtube.ts");
const { CINEMA_TITLE_MAX, createRoom, joinRoom, listMyRooms, patchRoom, readRoom } = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");

const host = { id: "student-host", name: "Ama Host" };
const guest = { id: "student-guest", name: "Kwesi Guest" };
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function expectRefusal(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

beforeEach(() => {
  state.rooms.length = 0;
  state.members.length = 0;
  state.metrics.clear();
});

test("a YouTube link, a bare id and a share link all become the id the room stores", () => {
  assert.deepEqual(parseYouTubeId("dQw4w9WgXcQ"), { ok: true, id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeId(VIDEO), { ok: true, id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeId("https://youtu.be/dQw4w9WgXcQ?si=abc"), { ok: true, id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeId("youtu.be/dQw4w9WgXcQ"), { ok: true, id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), { ok: true, id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), { ok: true, id: "dQw4w9WgXcQ" });

  // A lookalike host is not YouTube, and a playlist with no video in it is not
  // a room: both are refused rather than guessed at.
  assert.equal(parseYouTubeId("https://notyoutube.com/watch?v=dQw4w9WgXcQ").ok, false);
  assert.equal(parseYouTubeId("https://www.youtube.com/playlist?list=PL123").ok, false);
  assert.equal(parseYouTubeId("").ok, false);
});

test("creating a room attaches the video, joins the host, and starts closed but joinable", async () => {
  const room = await createRoom({ student: host, title: "  PHY 201   revision  ", video: VIDEO });
  assert.equal(room.title, "PHY 201 revision", "the title is cleaned rather than stored as typed");
  assert.equal(room.videoId, "dQw4w9WgXcQ");
  assert.equal(room.sourceType, "YOUTUBE");
  assert.equal(room.status, "CREATED");
  assert.equal(room.isHost, true);
  assert.equal(room.joinable, true, "a room that has not started is joinable");
  assert.equal(room.participants.length, 1, "the host is a participant from the first second");
  assert.equal(room.hostName, "Ama Host");
  assert.equal(state.metrics.get(`cinema_rooms_created:${new Date().toISOString().slice(0, 10)}`), 1);
});

test("a room with no name still has one, and a title longer than the cap is cut", async () => {
  const room = await createRoom({ student: host, title: "   ", video: VIDEO });
  assert.equal(room.title, "Study room");
  const long = await createRoom({ student: host, title: "x".repeat(200), video: "dQw4w9WgXcQ" });
  assert.equal(long.title.length, CINEMA_TITLE_MAX);
});

test("a second student joins once: a reload does not move the join time or duplicate the row", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  const joined = await joinRoom({ id: room.id, student: guest });
  assert.equal(joined.participants.length, 2);
  assert.equal(joined.isMember, true);
  assert.equal(joined.isHost, false);
  const firstJoin = state.members.find((member) => member.student_id === guest.id).joined_at;

  const again = await joinRoom({ id: room.id, student: guest });
  assert.equal(again.participants.length, 2, "joining twice is one membership");
  assert.equal(state.members.filter((member) => member.student_id === guest.id).length, 1);
  assert.equal(state.members.find((member) => member.student_id === guest.id).joined_at, firstJoin, "a reload is not a second join");
});

test("a locked room refuses a stranger and still admits its members", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  const locked = await patchRoom({ id: room.id, studentId: host.id, action: "LOCK" });
  assert.equal(locked.joinLocked, true);
  assert.equal(locked.joinable, true, "the host is still in the room they locked");

  await expectRefusal(joinRoom({ id: room.id, student: guest }), "FORBIDDEN", 403);

  await patchRoom({ id: room.id, studentId: host.id, action: "UNLOCK" });
  const after = await joinRoom({ id: room.id, student: guest });
  assert.equal(after.isMember, true);
});

test("only the host moves the room, and an ended room accepts nothing", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await joinRoom({ id: room.id, student: guest });
  await expectRefusal(patchRoom({ id: room.id, studentId: guest.id, action: "OPEN" }), "FORBIDDEN", 403);
  await expectRefusal(patchRoom({ id: room.id, studentId: host.id, action: "NONSENSE" }), "VALIDATION_ERROR", 400);

  const open = await patchRoom({ id: room.id, studentId: host.id, action: "OPEN" });
  assert.equal(open.status, "LIVE");
  assert.ok(open.startedAt, "opening the room records when it started");

  const ended = await patchRoom({ id: room.id, studentId: host.id, action: "END" });
  assert.equal(ended.status, "ENDED");
  assert.ok(ended.endedAt);
  await expectRefusal(patchRoom({ id: room.id, studentId: host.id, action: "OPEN" }), "INVALID_STATE", 409);
  await expectRefusal(joinRoom({ id: room.id, student: { id: "student-late", name: "Late" } }), "INVALID_STATE", 409);

  // An ended room still resolves, because the page has something to say about it.
  const read = await readRoom({ id: room.id, studentId: host.id });
  assert.equal(read.status, "ENDED");
});

test("the lobby lists the rooms a student is in, and nothing else", async () => {
  const first = await createRoom({ student: host, title: "Room one", video: VIDEO });
  const second = await createRoom({ student: host, title: "Room two", video: VIDEO });
  await joinRoom({ id: second.id, student: guest });

  const mine = await listMyRooms(guest.id);
  assert.deepEqual(mine.map((room) => room.id), [second.id]);
  assert.equal(mine[0].isHost, false);

  const hosted = await listMyRooms(host.id);
  assert.equal(hosted.length, 2);
  assert.deepEqual(new Set(hosted.map((room) => room.id)), new Set([first.id, second.id]));
});

test("a room that was never there, or was closed, is a 404 rather than a forbidden", async () => {
  await expectRefusal(readRoom({ id: "no-such-room" }), "NOT_FOUND", 404);
  await expectRefusal(readRoom({ id: "" }), "NOT_FOUND", 404);

  const room = await createRoom({ student: host, video: VIDEO });
  state.rooms.find((row) => row.id === room.id).status = "DELETED";
  await expectRefusal(joinRoom({ id: room.id, student: guest }), "NOT_FOUND", 404);
});
