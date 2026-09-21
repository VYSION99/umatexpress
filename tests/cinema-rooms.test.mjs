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
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const state = { rooms: [], members: [], invites: [], metrics: new Map(), failMembershipOnce: false };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });
const affected = (count) => ok({ affected_row_count: count });

const ROOM_COLUMNS = ["id", "host_student_id", "title", "video_source_type", "video_id", "status", "join_locked", "visibility", "starts_at", "ends_at", "duration_minutes", "started_at", "ended_at", "created_at", "updated_at"];
const MEMBER_COLUMNS = ["session_id", "student_id", "display_name", "joined_at", "last_seen_at", "left_at"];

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);
  if (/^ALTER TABLE/.test(sql)) return ok(empty);

  // The Turso rate-limit store, which the routes use when no Durable Object
  // binding is present. Each window is fresh, so every call is allowed.
  if (/^DELETE FROM rate_limit_windows/.test(sql)) return affected(0);
  if (/^INSERT INTO rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));
  if (/^SELECT count FROM rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));

  // The account behind the session cookie, for the route-level tests.
  if (/^PRAGMA table_info\(student_accounts\)/.test(sql)) {
    return ok(table(["name"], ["id", "email", "name", "phone", "password_hash", "password_salt", "password_iterations", "token_version", "email_verified", "active", "created_at", "updated_at", "last_login_at"].map((name) => ({ name }))));
  }
  if (/^SELECT COALESCE\(token_version,0\) AS token_version FROM student_accounts/.test(sql)) {
    return ok(STUDENT_ACCOUNTS.has(args[0]) ? table(["token_version"], [{ token_version: 0 }]) : empty);
  }
  if (/FROM student_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const account = STUDENT_ACCOUNTS.get(args[0]);
    return ok(account ? table(
      ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active"],
      [{ ...account, email: account.email, name: account.name, phone: "", created_at: "2026-09-01T00:00:00.000Z", last_login_at: "", token_version: 0 }],
    ) : empty);
  }

  if (/^INSERT INTO metrics_counters/.test(sql)) {
    const [name, day, amount] = args;
    const key = `${name}:${day}`;
    const count = (state.metrics.get(key) || 0) + Number(amount);
    state.metrics.set(key, count);
    return ok(table(["count"], [{ count }]));
  }

  if (/^INSERT INTO cinema_sessions/.test(sql)) {
    const [id, hostStudentId, title, sourceType, videoId, status, visibility, startsAt, endsAt, durationMinutes, startedAt, createdAt, updatedAt] = args;
    state.rooms.push({
      id, host_student_id: hostStudentId, title, video_source_type: sourceType, video_id: videoId,
      status: status || "CREATED", join_locked: 0, visibility: visibility || "PUBLIC",
      starts_at: startsAt || "", ends_at: endsAt || "", duration_minutes: Number(durationMinutes || 0),
      started_at: startedAt || "", ended_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^DELETE FROM cinema_sessions WHERE id = \?/.test(sql)) {
    const index = state.rooms.findIndex((room) => room.id === args[0]);
    if (index >= 0) state.rooms.splice(index, 1);
    return affected(index >= 0 ? 1 : 0);
  }
  if (/^SELECT id,host_student_id,title,video_source_type,video_id,status,join_locked,visibility,starts_at,ends_at,duration_minutes,started_at,ended_at,created_at,updated_at FROM cinema_sessions WHERE id = \? LIMIT 1/.test(sql)) {
    const row = state.rooms.find((room) => room.id === args[0]);
    return ok(row ? table(ROOM_COLUMNS, [row]) : empty);
  }
  if (/^INSERT OR IGNORE INTO cinema_participants/.test(sql)) {
    if (state.failMembershipOnce) {
      state.failMembershipOnce = false;
      return { type: "error", error: { message: "the membership write failed" } };
    }
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
  if (/^SELECT session_id, COUNT\(\*\) AS members FROM cinema_participants/.test(sql)) {
    const ids = args;
    const counts = new Map();
    for (const member of state.members) {
      if (!ids.includes(member.session_id) || member.left_at) continue;
      counts.set(member.session_id, (counts.get(member.session_id) || 0) + 1);
    }
    const rows = [...counts.entries()].map(([session_id, members]) => ({ session_id, members }));
    return ok(rows.length ? table(["session_id", "members"], rows) : empty);
  }
  if (/^UPDATE cinema_participants SET last_seen_at = \?, left_at = '' WHERE session_id = \? AND student_id = \?/.test(sql)) {
    const [lastSeenAt, sessionId, studentId] = args;
    const member = state.members.find((row) => row.session_id === sessionId && row.student_id === studentId);
    if (member) Object.assign(member, { last_seen_at: lastSeenAt, left_at: "" });
    return affected(member ? 1 : 0);
  }
  if (/^DELETE FROM cinema_participants WHERE session_id = \? AND student_id = \?$/.test(sql)) {
    const before = state.members.length;
    state.members = state.members.filter((member) => !(member.session_id === args[0] && member.student_id === args[1]));
    return affected(before - state.members.length);
  }
  if (/^UPDATE cinema_sessions SET status = 'LIVE'/.test(sql)) {
    const opening = /starts_at = ''/.test(sql);
    const [startedAt, updatedAt, id] = opening ? [args[0], args[3], args[4]] : args;
    const room = state.rooms.find((row) => row.id === id);
    if (room && (room.status === "CREATED" || room.status === "LIVE")) {
      room.status = "LIVE";
      room.started_at = room.started_at || startedAt;
      if (opening) {
        room.starts_at = "";
        if (Number(args[1]) > 0) room.ends_at = args[2];
      }
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
  if (/^UPDATE cinema_sessions SET visibility = \?/.test(sql)) {
    const [visibility, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (room) Object.assign(room, { visibility, updated_at: updatedAt });
    return affected(room ? 1 : 0);
  }
  if (/^UPDATE cinema_sessions SET title = \?/.test(sql)) {
    const [title, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (room) Object.assign(room, { title, updated_at: updatedAt });
    return affected(room ? 1 : 0);
  }
  if (/^SELECT student_id FROM cinema_room_invites WHERE session_id = \? AND student_id = \? LIMIT 1$/.test(sql)) {
    const row = state.invites.find((invite) => invite.session_id === args[0] && invite.student_id === args[1]);
    return ok(row ? table(["student_id"], [row]) : empty);
  }
  if (/^INSERT OR IGNORE INTO cinema_room_invites/.test(sql)) {
    const [sessionId, studentId, invitedBy, createdAt] = args;
    if (state.invites.some((invite) => invite.session_id === sessionId && invite.student_id === studentId)) return affected(0);
    state.invites.push({ session_id: sessionId, student_id: studentId, invited_by: invitedBy, created_at: createdAt });
    return affected(1);
  }
  if (/^DELETE FROM cinema_room_invites WHERE session_id = \? AND student_id = \?$/.test(sql)) {
    const before = state.invites.length;
    state.invites = state.invites.filter((invite) => !(invite.session_id === args[0] && invite.student_id === args[1]));
    return affected(before - state.invites.length);
  }
  if (/^SELECT i\.student_id,COALESCE\(a\.email,''\) AS email/.test(sql)) {
    const rows = state.invites
      .filter((invite) => invite.session_id === args[0])
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .map((invite) => {
        const account = STUDENT_ACCOUNTS.get(invite.student_id);
        return { student_id: invite.student_id, email: account?.email || "", name: account?.name || "", created_at: invite.created_at };
      });
    return ok(rows.length ? table(["student_id", "email", "name", "created_at"], rows) : empty);
  }
  if (/^SELECT id,COALESCE\(name,''\) AS name FROM student_accounts WHERE lower\(email\) = \?/.test(sql)) {
    const account = [...STUDENT_ACCOUNTS.values()].find((entry) => entry.email === args[0] && entry.active);
    return ok(account ? table(["id", "name"], [account]) : empty);
  }
  if (/FROM cinema_sessions s[\s\S]*LEFT JOIN cinema_participants p/.test(sql)) {
    const studentId = args[0];
    const joined = new Set(state.members.filter((member) => member.student_id === studentId).map((member) => member.session_id));
    const invited = new Set(state.invites.filter((invite) => invite.student_id === studentId).map((invite) => invite.session_id));
    const rows = state.rooms
      .filter((room) => room.status !== "DELETED" && (joined.has(room.id) || invited.has(room.id)))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, 20)
      .map((room) => ({ ...room, invited: invited.has(room.id) ? 1 : 0 }));
    return ok(rows.length ? table([...ROOM_COLUMNS, "invited"], rows) : empty);
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
const ACCOUNT = {
  id: "student-host", email: "ama@st.umat.edu.gh", name: "Ama Host", phone: "0244000000",
  created_at: "2026-09-01T00:00:00.000Z", last_login_at: "", token_version: 0, active: 1,
};
const STUDENT_ACCOUNTS = new Map([
  [ACCOUNT.id, ACCOUNT],
  ["student-guest", { id: "student-guest", email: "kwesi@st.umat.edu.gh", name: "Kwesi Guest", active: 1 }],
]);
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { parseYouTubeId } = await vite.ssrLoadModule("/lib/cinema-engine/youtube.ts");
const {
  CINEMA_TITLE_MAX, createRoom, inviteToRoom, joinRoom, listMyRooms, listRoomInvites,
  patchRoom, readRoom, removeRoomGuest, removeRoomInvite,
} = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const { studentSessionCookie } = await vite.ssrLoadModule("/lib/student-auth.ts");
const sessionsRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/route.ts");
const invitesRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/invites/route.ts");
const guestsRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/guests/route.ts");
const socketRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/ws/route.ts");

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
  state.invites.length = 0;
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

test("a room created for now is live before anyone presses play", async () => {
  const room = await createRoom({ student: host, title: "Starts now", video: VIDEO, startInMinutes: 0, durationMinutes: 60 });
  assert.equal(room.status, "LIVE", "a start of now is the room's own play press");
  assert.ok(room.startedAt, "the row records the moment it went live");
  const startsAt = Date.parse(room.startsAt);
  const endsAt = Date.parse(room.endsAt);
  assert.ok(Number.isFinite(startsAt) && Number.isFinite(endsAt), "both instants are on the row");
  assert.equal(Math.round((endsAt - startsAt) / 60_000), 60, "the run time is the host's, to the minute");
  assert.equal(room.durationMinutes, 60);
});

test("a room with a start waits for its minute", async () => {
  const room = await createRoom({ student: host, title: "Later", video: VIDEO, startInMinutes: 30 });
  assert.equal(room.status, "CREATED");
  assert.equal(room.startedAt, "");
  assert.equal(room.endsAt, "", "no run time means only the host ends it");
  assert.ok(Math.abs(Date.parse(room.startsAt) - (Date.now() + 30 * 60_000)) < 5_000, "the start is thirty minutes out, on the server's clock");

  const legacy = await createRoom({ student: host, title: "No clock", video: VIDEO });
  assert.equal(legacy.startsAt, "", "a create call that never mentions a clock keeps the room it always made");
  assert.equal(legacy.status, "CREATED");
});

test("a due room goes live when the first reader arrives, and an overrun one ends", async () => {
  const due = await createRoom({ student: host, title: "Due", video: VIDEO, startInMinutes: 10 });
  const promised = new Date(Date.now() - 60_000).toISOString();
  state.rooms.find((row) => row.id === due.id).starts_at = promised;
  const read = await readRoom({ id: due.id, studentId: host.id });
  assert.equal(read.status, "LIVE", "the minute moved the room without an alarm");
  assert.equal(read.startedAt, promised, "it went live when it was promised, not when it was read");

  const overrun = await createRoom({ student: host, title: "Overrun", video: VIDEO, startInMinutes: 30, durationMinutes: 30 });
  const row = state.rooms.find((item) => item.id === overrun.id);
  row.starts_at = new Date(Date.now() - 90 * 60_000).toISOString();
  row.ends_at = new Date(Date.now() - 60 * 60_000).toISOString();
  const ended = await readRoom({ id: overrun.id, studentId: host.id });
  assert.equal(ended.status, "ENDED");
  assert.ok(ended.endedAt, "the row says when it ended");
});

test("a room refuses a clock it cannot keep", async () => {
  await expectRefusal(createRoom({ student: host, title: "Too far", video: VIDEO, startInMinutes: 60 * 24 * 9 }), "VALIDATION_ERROR", 400);
  await expectRefusal(createRoom({ student: host, title: "Too short", video: VIDEO, durationMinutes: 5 }), "VALIDATION_ERROR", 400);
  await expectRefusal(createRoom({ student: host, title: "Too long", video: VIDEO, durationMinutes: 500 }), "VALIDATION_ERROR", 400);
});

test("a room asked for at creation as invite-only is private before anyone knocks", async () => {
  const room = await createRoom({ student: host, title: "Private revision", video: VIDEO, visibility: "PRIVATE" });
  assert.equal(room.visibility, "PRIVATE");
  assert.equal(room.isPrivate, true);
  assert.equal(room.sourceType, "YOUTUBE", "the door choice does not touch the video");
  assert.equal(room.videoId, "dQw4w9WgXcQ");
  assert.equal(room.joinable, true, "the host can always walk into their own room");
  await expectRefusal(readRoom({ id: room.id, studentId: guest.id }), "FORBIDDEN", 403);
  await expectRefusal(joinRoom({ id: room.id, student: guest }), "FORBIDDEN", 403);
});

test("an upload room is created empty, private, and waiting for its file", async () => {
  const room = await createRoom({ student: host, title: "Field trip", source: "UPLOAD", visibility: "PUBLIC" });
  assert.equal(room.sourceType, "UPLOAD");
  assert.equal(room.videoId, "", "the upload that follows is what fills this in");
  assert.equal(room.visibility, "PRIVATE", "a file can never open the door it will close");
  assert.equal(room.status, "CREATED");
  assert.equal(room.joinable, true);
  await expectRefusal(readRoom({ id: room.id, studentId: guest.id }), "FORBIDDEN", 403);
});

test("a source no room understands, and a YouTube room with no link, are both refused", async () => {
  await expectRefusal(createRoom({ student: host, video: VIDEO, source: "STREAM" }), "VALIDATION_ERROR", 400);
  await expectRefusal(createRoom({ student: host, video: VIDEO, source: "UPLOADISH" }), "VALIDATION_ERROR", 400);
  await expectRefusal(createRoom({ student: host, video: "" }), "VALIDATION_ERROR", 400);
  await expectRefusal(createRoom({ student: host, source: "YOUTUBE", video: "https://example.com/watch?v=x" }), "VALIDATION_ERROR", 400);
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

test("an ended room refuses a member's join too, so the page and the engine agree", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await joinRoom({ id: room.id, student: guest });
  await patchRoom({ id: room.id, studentId: host.id, action: "END" });
  await expectRefusal(joinRoom({ id: room.id, student: guest }), "INVALID_STATE", 409);
});

test("a membership write that fails does not leave a room nobody can open", async () => {
  state.failMembershipOnce = true;
  await assert.rejects(createRoom({ student: host, video: VIDEO }), /membership write failed/);
  assert.equal(state.rooms.length, 0, "the room is put back when its host could not be added");
});

test("the lobby counts members without reading every name", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await joinRoom({ id: room.id, student: guest });
  const [listed] = await listMyRooms(host.id);
  assert.equal(listed.id, room.id);
  assert.equal(listed.verifiedCount, 2, "the count comes from the grouped query");
  assert.equal(listed.participants.length, 0, "the lobby does not carry member names");
  assert.equal(listed.isHost, true);
});

test("a room becomes private, and a stranger with the link is refused the read and the join", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  assert.equal(room.visibility, "PUBLIC");
  assert.equal(room.isPrivate, false);
  assert.equal(room.joinable, true);

  const closed = await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });
  assert.equal(closed.visibility, "PRIVATE");
  assert.equal(closed.isPrivate, true);
  assert.equal(closed.joinable, true, "the host can always walk back into their own room");
  assert.equal((await readRoom({ id: room.id, studentId: host.id })).isPrivate, true, "the host still reads it");

  await expectRefusal(readRoom({ id: room.id, studentId: guest.id }), "FORBIDDEN", 403);
  await expectRefusal(joinRoom({ id: room.id, student: guest }), "FORBIDDEN", 403);
  await expectRefusal(inviteToRoom({ id: room.id, studentId: guest.id, email: "kwesi@st.umat.edu.gh" }), "FORBIDDEN", 403);

  const open = await patchRoom({ id: room.id, studentId: host.id, action: "PUBLIC" });
  assert.equal(open.visibility, "PUBLIC");
  assert.equal(open.joinable, true);
  assert.equal((await joinRoom({ id: room.id, student: guest })).isMember, true);
});

test("an invitation names an existing UMaT address, and lets it read and join", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });

  await expectRefusal(inviteToRoom({ id: room.id, studentId: host.id, email: "ghost@st.umat.edu.gh" }), "NOT_FOUND", 404);
  await expectRefusal(inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@gmail.com" }), "VALIDATION_ERROR", 400);
  await expectRefusal(inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@umat.edu.gh" }), "VALIDATION_ERROR", 400);
  await expectRefusal(inviteToRoom({ id: room.id, studentId: host.id, email: ACCOUNT.email }), "VALIDATION_ERROR", 400);

  const invited = await inviteToRoom({ id: room.id, studentId: host.id, email: "Kwesi@st.umat.edu.gh" });
  assert.equal(invited.invite.studentId, guest.id, "the address resolves to the one account that owns it");
  assert.equal(invited.invites.length, 1);
  assert.equal(invited.invites[0].name, "Kwesi Guest");
  assert.equal((await listRoomInvites({ id: room.id, studentId: host.id })).invites.length, 1, "inviting twice is idempotent");
  await inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@st.umat.edu.gh" });
  assert.equal((await listRoomInvites({ id: room.id, studentId: host.id })).invites.length, 1);

  const seen = await readRoom({ id: room.id, studentId: guest.id });
  assert.equal(seen.invited, true);
  assert.equal(seen.joinable, true, "an invited student may walk in");
  assert.equal((await joinRoom({ id: room.id, student: guest })).isMember, true);

  const [listed] = await listMyRooms(guest.id);
  assert.equal(listed.id, room.id);
  assert.equal(listed.invited, true, "the lobby shows the room with its invitation");
  assert.equal(listed.isPrivate, true);

  const takenBack = await removeRoomInvite({ id: room.id, studentId: host.id, inviteeId: guest.id });
  assert.equal(takenBack.removed, true);
  assert.equal(takenBack.invites.length, 0);
  assert.equal((await listMyRooms(guest.id)).length, 1, "taking an invitation back never removes a member");
});

test("the invite route is the host's, and it answers with the list every time", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });
  const context = (id) => ({ params: Promise.resolve({ id }) });
  const base = `https://umatexpress.test/api/cinema/sessions/${room.id}/invites`;
  const cookie = await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/"));
  const guestCookie = await studentSessionCookie("student-guest", new Request("https://umatexpress.test/"));

  const anonymous = await invitesRoute.GET(new Request(base), context(room.id));
  assert.equal(anonymous.status, 401, "an invitation list is not readable without an account");
  const refused = await invitesRoute.GET(new Request(base, { headers: { cookie: guestCookie } }), context(room.id));
  assert.equal(refused.status, 403, "and never by anyone but the host");

  const sent = await invitesRoute.POST(new Request(base, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "kwesi@st.umat.edu.gh" }),
  }), context(room.id));
  const sentPayload = await sent.json();
  assert.equal(sent.status, 201, JSON.stringify(sentPayload));
  assert.equal(sentPayload.invites.length, 1);

  const listed = await invitesRoute.GET(new Request(base, { headers: { cookie } }), context(room.id));
  const listedPayload = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(listedPayload.invites[0].studentId, guest.id);

  const removed = await invitesRoute.DELETE(new Request(`${base}?studentId=${guest.id}`, { method: "DELETE", headers: { cookie } }), context(room.id));
  const removedPayload = await removed.json();
  assert.equal(removed.status, 200);
  assert.equal(removedPayload.removed, true);
  assert.deepEqual(removedPayload.invites, []);
});

test("the lock is a door of its own: an invitation never walks past it", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "LOCK" });
  await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });
  await inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@st.umat.edu.gh" });

  const seen = await readRoom({ id: room.id, studentId: guest.id });
  assert.equal(seen.invited, true, "the guest list still names them");
  assert.equal(seen.joinable, false, "but the locked door does not open for an invitation");
  await expectRefusal(joinRoom({ id: room.id, student: guest }), "FORBIDDEN", 403);

  await patchRoom({ id: room.id, studentId: host.id, action: "UNLOCK" });
  assert.equal((await joinRoom({ id: room.id, student: guest })).isMember, true, "unlocking lets the same invitation through");
});

test("the host removes a guest: invitation, seat and lobby entry go together", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });
  await inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@st.umat.edu.gh" });
  await joinRoom({ id: room.id, student: guest });
  assert.equal((await listMyRooms(guest.id)).length, 1);

  await expectRefusal(removeRoomGuest({ id: room.id, studentId: guest.id, guestId: host.id }), "FORBIDDEN", 403, "a guest cannot remove anyone");
  await expectRefusal(removeRoomGuest({ id: room.id, studentId: host.id, guestId: host.id }), "VALIDATION_ERROR", 400, "the host is not a guest of their own room");

  const removed = await removeRoomGuest({ id: room.id, studentId: host.id, guestId: guest.id });
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.invites, [], "the invitation goes with the seat");
  assert.equal(state.members.filter((member) => member.session_id === room.id).length, 1, "only the host is left in the room");
  assert.equal((await listMyRooms(guest.id)).length, 0, "the room leaves the guest's lobby with the seat");
  await expectRefusal(readRoom({ id: room.id, studentId: guest.id }), "FORBIDDEN", 403, "and the link stops resolving for them");

  // A student who was only invited loses the invitation and nothing else.
  const second = await createRoom({ student: host, title: "Second", video: VIDEO });
  await patchRoom({ id: second.id, studentId: host.id, action: "PRIVATE" });
  await inviteToRoom({ id: second.id, studentId: host.id, email: "kwesi@st.umat.edu.gh" });
  const uninvited = await removeRoomGuest({ id: second.id, studentId: host.id, guestId: guest.id });
  assert.equal(uninvited.removed, true);
  assert.deepEqual(uninvited.invites, []);
  await expectRefusal(readRoom({ id: second.id, studentId: guest.id }), "FORBIDDEN", 403);
});

test("an invited member holds guest privileges, never the host's", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });
  await inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@st.umat.edu.gh" });
  await joinRoom({ id: room.id, student: guest });

  await expectRefusal(patchRoom({ id: room.id, studentId: guest.id, action: "PUBLIC" }), "FORBIDDEN", 403);
  await expectRefusal(patchRoom({ id: room.id, studentId: guest.id, action: "LOCK" }), "FORBIDDEN", 403);
  await expectRefusal(patchRoom({ id: room.id, studentId: guest.id, action: "RETITLE", title: "Mine now" }), "FORBIDDEN", 403);
  await expectRefusal(patchRoom({ id: room.id, studentId: guest.id, action: "END" }), "FORBIDDEN", 403);
  await expectRefusal(listRoomInvites({ id: room.id, studentId: guest.id }), "FORBIDDEN", 403, "a guest never reads the guest list");
  await expectRefusal(inviteToRoom({ id: room.id, studentId: guest.id, email: "ama@st.umat.edu.gh" }), "FORBIDDEN", 403);
  await expectRefusal(removeRoomGuest({ id: room.id, studentId: guest.id, guestId: host.id }), "FORBIDDEN", 403);

  const seen = await readRoom({ id: room.id, studentId: guest.id });
  assert.equal(seen.isHost, false);
  assert.equal(seen.isPrivate, true);
  assert.equal(seen.isMember, true);
});

test("the guests route removes an invited member, and refuses everyone but the host", async () => {
  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "PRIVATE" });
  await inviteToRoom({ id: room.id, studentId: host.id, email: "kwesi@st.umat.edu.gh" });
  await joinRoom({ id: room.id, student: guest });

  const context = (id) => ({ params: Promise.resolve({ id }) });
  const base = `https://umatexpress.test/api/cinema/sessions/${room.id}/guests?studentId=${guest.id}`;
  const cookie = await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/"));
  const guestCookie = await studentSessionCookie("student-guest", new Request("https://umatexpress.test/"));

  const anonymous = await guestsRoute.DELETE(new Request(base, { method: "DELETE" }), context(room.id));
  assert.equal(anonymous.status, 401);
  const refused = await guestsRoute.DELETE(new Request(base, { method: "DELETE", headers: { cookie: guestCookie } }), context(room.id));
  assert.equal(refused.status, 403, "a guest cannot remove anyone, least of all themselves");

  const removed = await guestsRoute.DELETE(new Request(base, { method: "DELETE", headers: { cookie } }), context(room.id));
  const payload = await removed.json();
  assert.equal(removed.status, 200, JSON.stringify(payload));
  assert.equal(payload.removed, true);
  assert.deepEqual(payload.invites, []);
});

test("the routes require the platform account, and create a room for it once signed in", async () => {
  const anonymous = await sessionsRoute.GET(new Request("https://umatexpress.test/api/cinema/sessions"));
  assert.equal(anonymous.status, 401, "the lobby list is not readable without an account");

  const request = new Request("https://umatexpress.test/api/cinema/sessions", { headers: { cookie: await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/")) } });
  const response = await sessionsRoute.POST(new Request(request.url, {
    method: "POST",
    headers: { cookie: request.headers.get("cookie"), "content-type": "application/json" },
    body: JSON.stringify({ title: "From the route", video: VIDEO }),
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.room.title, "From the route");
  assert.equal(payload.room.isHost, true);
  assert.equal(payload.room.participants.length, 1);

  const listed = await sessionsRoute.GET(request);
  assert.equal(listed.status, 200);
  const listPayload = await listed.json();
  assert.equal(listPayload.rooms.length, 1);
  assert.equal(listPayload.rooms[0].id, payload.room.id);
});

test("the create route carries the lobby's two choices without losing the upload rule", async () => {
  const request = new Request("https://umatexpress.test/api/cinema/sessions", { headers: { cookie: await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/")) } });
  const response = await sessionsRoute.POST(new Request(request.url, {
    method: "POST",
    headers: { cookie: request.headers.get("cookie"), "content-type": "application/json" },
    body: JSON.stringify({ title: "Upload night", source: "UPLOAD", visibility: "PUBLIC" }),
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.room.sourceType, "UPLOAD");
  assert.equal(payload.room.videoId, "", "the room waits for the file the lobby is about to send");
  assert.equal(payload.room.visibility, "PRIVATE", "the route cannot be talked out of the upload rule");

  const privateResponse = await sessionsRoute.POST(new Request(request.url, {
    method: "POST",
    headers: { cookie: request.headers.get("cookie"), "content-type": "application/json" },
    body: JSON.stringify({ title: "Invite only", video: VIDEO, visibility: "PRIVATE" }),
  }));
  const privatePayload = await privateResponse.json();
  assert.equal(privateResponse.status, 201, JSON.stringify(privatePayload));
  assert.equal(privatePayload.room.visibility, "PRIVATE");
  assert.equal(privatePayload.room.sourceType, "YOUTUBE");
});

test("the create route hands the lobby's clock to the engine", async () => {
  const cookie = await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/"));
  const response = await sessionsRoute.POST(new Request("https://umatexpress.test/api/cinema/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "Later", video: VIDEO, startInMinutes: 15, durationMinutes: 30 }),
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.room.status, "CREATED");
  assert.equal(payload.room.durationMinutes, 30);
  assert.ok(Math.abs(Date.parse(payload.room.startsAt) - (Date.now() + 15 * 60_000)) < 5_000, "the engine computes the instant, not the browser");
});

test("the socket route refuses anyone the room itself would refuse", async () => {
  const context = (id) => ({ params: Promise.resolve({ id }) });
  const url = "https://umatexpress.test/api/cinema/sessions/room-x/ws";
  const cookie = await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/"));

  const anonymous = await socketRoute.GET(new Request(url, { headers: { upgrade: "websocket" } }), context("room-x"));
  assert.equal(anonymous.status, 401, "no session, no socket");

  const plainHttp = await socketRoute.GET(new Request(url, { headers: { cookie } }), context("room-x"));
  assert.equal(plainHttp.status, 426, "an upgrade endpoint asked over plain HTTP explains itself");

  const missing = await socketRoute.GET(new Request(url, { headers: { cookie, upgrade: "websocket" } }), context("no-such-room"));
  assert.equal(missing.status, 404, "a room that is not there is not connectable");

  const room = await createRoom({ student: host, video: VIDEO });
  await patchRoom({ id: room.id, studentId: host.id, action: "END" });
  const ended = await socketRoute.GET(
    new Request(url, { headers: { cookie, upgrade: "websocket" } }),
    context(room.id),
  );
  assert.equal(ended.status, 409, "an ended room has nothing to listen to");
});

test("an active room without the realtime binding is a 503, not a crash", async () => {
  // Unit tests run in Node, where the Durable Object namespace does not exist.
  // The route must say so plainly rather than fail the request obscurely.
  const room = await createRoom({ student: host, video: VIDEO });
  const cookie = await studentSessionCookie(ACCOUNT.id, new Request("https://umatexpress.test/"));
  const response = await socketRoute.GET(
    new Request("https://umatexpress.test/api/cinema/sessions/room/ws", { headers: { cookie, upgrade: "websocket" } }),
    { params: Promise.resolve({ id: room.id }) },
  );
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.match(payload.error, /Live rooms are not available/);
});
