import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema's console half: the room list, the moderator's end/remove actions,
 * and the report queue students feed.
 *
 * The fake Turso keeps the sessions, participants, messages and signals in
 * memory and refuses anything untaught, so a guard that stops running shows up
 * as a failing test rather than a silent pass.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-console-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const state = {
  sessions: [], participants: [], messages: [], signals: [], uploads: [], audits: [],
  schema: new Map(), windows: new Map(), metrics: [],
};

const ACCOUNTS = new Map([
  ["console-admin", { id: "console-admin", email: "admin@umat.edu.gh", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "" }],
  ["console-moderator", { id: "console-moderator", email: "mod@umat.edu.gh", name: "Mod", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "" }],
  ["console-organizer", { id: "console-organizer", email: "organizer@example.com", name: "Organizer", phone: "", role: "ORGANIZER", status: "ACTIVE", profile_id: "" }],
]);
const STUDENTS = new Map([
  ["student-a", { id: "student-a", email: "a@st.umat.edu.gh", name: "Ama", phone: "", created_at: "2026-01-01T00:00:00.000Z", last_login_at: "", token_version: 0, active: 1 }],
  ["student-b", { id: "student-b", email: "b@st.umat.edu.gh", name: "Kwesi", phone: "", created_at: "2026-01-01T00:00:00.000Z", last_login_at: "", token_version: 0, active: 1 }],
]);

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const affected = (count) => ok({ affected_row_count: count });
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });

const SESSION_COLUMNS = ["id", "host_student_id", "title", "video_source_type", "video_id", "status", "join_locked", "visibility", "starts_at", "ends_at", "duration_minutes", "started_at", "ended_at", "created_at", "updated_at"];
const MESSAGE_COLUMNS = ["id", "session_id", "sender_id", "sender_name", "content", "metadata", "created_at"];
const SIGNAL_COLUMNS = ["id", "signal_key", "severity", "entity_type", "entity_id", "session_id", "reporter_id", "reporter_name", "report_count", "title", "detail", "evidence", "status", "reviewed_by", "reviewed_at", "review_note", "created_at", "updated_at"];
const UPLOAD_COLUMNS = ["id", "session_id", "uploader_id", "r2_object_key", "r2_upload_id", "original_filename", "file_size_bytes", "mime_type", "duration_seconds", "ownership_confirmed", "status", "expires_at", "deleted_at", "removed_by", "removed_reason", "created_at", "updated_at"];

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) {
    const version = state.schema.get(String(args[0] || ""));
    return version ? ok(table(["version"], [{ version }])) : ok(empty);
  }
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) {
    state.schema.set(String(args[0] || ""), String(args[1] || ""));
    return affected(1);
  }
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);
  if (/^ALTER TABLE/.test(sql)) return ok(empty);

  if (/^DELETE FROM rate_limit_windows/.test(sql)) return affected(0);
  if (/^INSERT INTO rate_limit_windows/.test(sql)) {
    const key = `${args[0]}:${args[1]}:${args[2]}`;
    const count = (state.windows.get(key) || 0) + 1;
    state.windows.set(key, count);
    return ok(table(["count"], [{ count }]));
  }
  if (/^SELECT count FROM rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));

  if (/^PRAGMA table_info\(student_accounts\)/.test(sql)) {
    return ok(table(["name"], [{ name: "id" }, { name: "token_version" }, { name: "email_verified" }, { name: "active" }]));
  }
  if (/^SELECT COALESCE\(token_version,0\) AS token_version FROM (student|console)_accounts/.test(sql)) {
    const source = /student_accounts/.test(sql) ? STUDENTS : ACCOUNTS;
    const row = source.get(args[0]);
    return ok(row ? table(["token_version"], [{ token_version: row.token_version ?? 0 }]) : empty);
  }
  if (/^SELECT COALESCE\(token_version,0\) AS token_version FROM console_accounts/.test(sql)) {
    return ACCOUNTS.has(args[0]) ? ok(table(["token_version"], [{ token_version: 0 }])) : ok(empty);
  }
  if (/^SELECT id,email,COALESCE\(name,''\) AS name/.test(sql)) {
    const row = STUDENTS.get(args[0]);
    return ok(row ? table(["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active"], [row]) : empty);
  }
  if (/^SELECT id,email,name,COALESCE\(phone,''\) AS phone,role,status/.test(sql)) {
    const row = ACCOUNTS.get(args[0]);
    return ok(row ? table(["id", "email", "name", "phone", "role", "status", "profile_id"], [row]) : empty);
  }

  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    state.audits.push({ actor: args[1], action: args[2], target_type: args[3], target_reference: args[4], details: args[5] });
    return affected(1);
  }
  if (/^INSERT INTO metrics_counters/.test(sql)) { state.metrics.push(args[0]); return ok(table(["count"], [{ count: 1 }])); }

  if (/^SELECT id,host_student_id,title,video_source_type,video_id,status,join_locked,visibility,starts_at,ends_at,duration_minutes,started_at,ended_at,created_at,updated_at FROM cinema_sessions WHERE id = \?/.test(sql)) {
    const row = state.sessions.find((session) => session.id === args[0]);
    return ok(row ? table(SESSION_COLUMNS, [row]) : empty);
  }
  if (/FROM cinema_sessions s[\s\S]*LEFT JOIN cinema_participants p/.test(sql)) {
    // The ORDER BY also mentions the active statuses; only the WHERE clause decides the filter.
    const where = sql.slice(sql.indexOf("WHERE"), sql.indexOf("ORDER BY"));
    const active = /s\.status IN \('CREATED','LIVE'\)/.test(where);
    const ended = /s\.status IN \('ENDED','EXPIRED'\)/.test(where);
    let rows = state.sessions.filter((session) => active ? ["CREATED", "LIVE"].includes(session.status) : ended ? ["ENDED", "EXPIRED"].includes(session.status) : session.status !== "DELETED");
    if (/LIKE \?/.test(sql)) {
      const needle = String(args[0] || "").replace(/%/g, "").toLowerCase();
      rows = rows.filter((session) => `${session.title} ${session.id} ${session.host_name || ""}`.toLowerCase().includes(needle));
    }
    rows = rows.slice(0, Number((sql.match(/LIMIT (\d+)/) || [])[1] || 100));
    return ok(rows.length ? table([...SESSION_COLUMNS, "host_name"], rows.map((session) => ({ ...session, host_name: session.host_name || "" }))) : empty);
  }
  if (/^UPDATE cinema_sessions SET status = 'ENDED'/.test(sql)) {
    let count = 0;
    for (const session of state.sessions) {
      if (session.id === args[2] && ["CREATED", "LIVE"].includes(session.status)) { session.status = "ENDED"; session.ended_at = args[0]; session.updated_at = args[1]; count += 1; }
    }
    return affected(count);
  }
  if (/^UPDATE cinema_sessions SET video_source_type = 'YOUTUBE', video_id = '', updated_at = \?/.test(sql)) {
    const [updatedAt, id, videoId] = args;
    const session = state.sessions.find((row) => row.id === id);
    if (!session || session.video_source_type !== "UPLOAD" || session.video_id !== videoId) return affected(0);
    Object.assign(session, { video_source_type: "YOUTUBE", video_id: "", updated_at: updatedAt });
    return affected(1);
  }

  if (/^SELECT id,session_id,uploader_id,r2_object_key/.test(sql)) {
    const row = state.uploads.find((upload) => upload.session_id === args[0]);
    return ok(row ? table(UPLOAD_COLUMNS, [row]) : empty);
  }
  if (/^SELECT COUNT\(\*\) AS removals FROM cinema_uploads/.test(sql)) {
    const [uploaderId, excludeId] = args;
    const removals = state.uploads.filter((upload) => upload.uploader_id === uploaderId && upload.removed_by && upload.id !== excludeId).length;
    return ok(table(["removals"], [{ removals }]));
  }
  if (/^UPDATE cinema_uploads SET status = 'DELETING'/.test(sql)) {
    const upload = state.uploads.find((row) => row.id === args[1]);
    if (upload) Object.assign(upload, { status: "DELETING", updated_at: args[0] });
    return affected(upload ? 1 : 0);
  }
  if (/^UPDATE cinema_uploads SET status = 'DELETED', deleted_at = \?, removed_by = \?, removed_reason = \?, updated_at = \?/.test(sql)) {
    const upload = state.uploads.find((row) => row.id === args[4] && row.status === "DELETING");
    if (!upload) return affected(0);
    Object.assign(upload, { status: "DELETED", deleted_at: args[0], removed_by: args[1], removed_reason: args[2], updated_at: args[3] });
    return affected(1);
  }

  if (/^SELECT session_id,student_id,display_name,joined_at,last_seen_at,left_at FROM cinema_participants/.test(sql)) {
    const rows = state.participants.filter((member) => args.includes(member.session_id));
    return ok(rows.length ? table(["session_id", "student_id", "display_name", "joined_at", "last_seen_at", "left_at"], rows) : empty);
  }
  if (/^SELECT session_id, COUNT\(\*\) AS members FROM cinema_participants/.test(sql)) {
    const grouped = new Map();
    for (const member of state.participants) {
      if (!args.includes(member.session_id) || member.left_at) continue;
      grouped.set(member.session_id, (grouped.get(member.session_id) || 0) + 1);
    }
    const rows = [...grouped].map(([session_id, members]) => ({ session_id, members }));
    return ok(rows.length ? table(["session_id", "members"], rows) : empty);
  }

  if (/^SELECT id,session_id,sender_id,sender_name,content,metadata,created_at FROM cinema_messages WHERE id = \?/.test(sql)) {
    const row = state.messages.find((message) => message.id === args[0]);
    return ok(row ? table(MESSAGE_COLUMNS, [row]) : empty);
  }
  if (/^DELETE FROM cinema_messages WHERE id = \?/.test(sql)) {
    const before = state.messages.length;
    state.messages = state.messages.filter((message) => message.id !== args[0]);
    return affected(before - state.messages.length);
  }

  if (/^SELECT id,report_count,evidence FROM cinema_risk_signals/.test(sql)) {
    const row = state.signals.find((signal) => signal.signal_key === args[0] && signal.entity_id === args[1] && signal.status === "OPEN");
    return ok(row ? table(["id", "report_count", "evidence"], [row]) : empty);
  }
  if (/^INSERT INTO cinema_risk_signals/.test(sql)) {
    const signal = {
      id: args[0], signal_key: args[1], severity: args[2], entity_type: args[3], entity_id: args[4], session_id: args[5],
      reporter_id: args[6], reporter_name: args[7], report_count: args[8], title: args[9], detail: args[10], evidence: args[11],
      status: "OPEN", reviewed_by: "", reviewed_at: "", review_note: "", created_at: args[12], updated_at: args[13],
    };
    state.signals.push(signal);
    return affected(1);
  }
  if (/^UPDATE cinema_risk_signals SET severity = \?/.test(sql)) {
    const signal = state.signals.find((entry) => entry.id === args[7]);
    if (!signal) return affected(0);
    Object.assign(signal, { severity: args[0], reporter_id: args[1], reporter_name: args[2], report_count: args[3], detail: args[4], evidence: args[5], updated_at: args[6] });
    return affected(1);
  }
  if (/^UPDATE cinema_risk_signals SET status = \?/.test(sql)) {
    const signal = state.signals.find((entry) => entry.id === args[5]);
    if (!signal || signal.status !== "OPEN") return affected(0);
    Object.assign(signal, { status: args[0], reviewed_by: args[1], reviewed_at: args[2], review_note: args[3], updated_at: args[4] });
    return affected(1);
  }
  if (/^SELECT id,status FROM cinema_risk_signals WHERE id = \?/.test(sql)) {
    const row = state.signals.find((signal) => signal.id === args[0]);
    return ok(row ? table(["id", "status"], [row]) : empty);
  }
  if (/^SELECT id,signal_key,severity,entity_type,entity_id,session_id/.test(sql)) {
    const rows = state.signals.filter((signal) => signal.status === args[0]).sort((left, right) => {
      const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3);
    });
    return ok(rows.length ? table(SIGNAL_COLUMNS, rows) : empty);
  }

  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://cinema-console-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests
      .filter((request) => request.type === "execute")
      .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { fileCinemaReport, listCinemaSignals, resolveCinemaSignal } = await vite.ssrLoadModule("/lib/cinema-engine/signals.ts");
const { listRoomsForConsole, endRoomAsStaff } = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const { removeCinemaMessage } = await vite.ssrLoadModule("/lib/cinema-engine/messages.ts");
const sessionsRoute = await vite.ssrLoadModule("/app/api/console/cinema/sessions/route.ts");
const sessionRoute = await vite.ssrLoadModule("/app/api/console/cinema/sessions/[id]/route.ts");
const signalsRoute = await vite.ssrLoadModule("/app/api/console/cinema/signals/route.ts");
const reportRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/report/route.ts");
const { createConsoleSession, CONSOLE_SESSION_COOKIE } = await vite.ssrLoadModule("/lib/console-auth.ts");
const { createStudentSession, STUDENT_SESSION_COOKIE } = await vite.ssrLoadModule("/lib/student-auth.ts");

const stamp = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function session(overrides = {}) {
  return {
    id: "room-1", host_student_id: "student-a", title: "Signals", video_source_type: "YOUTUBE", video_id: "M7lc1UVf-VE",
    status: "LIVE", join_locked: 0, started_at: stamp(60), ended_at: "", created_at: stamp(90), updated_at: stamp(1),
    host_name: "", ...overrides,
  };
}

beforeEach(() => {
  state.sessions = [session()];
  state.participants = [{ session_id: "room-1", student_id: "student-a", display_name: "Ama", joined_at: stamp(90), last_seen_at: stamp(1), left_at: "" }];
  state.messages = [{ id: "message-1", session_id: "room-1", sender_id: "student-b", sender_name: "Kwesi", content: "This is off topic", metadata: "", created_at: stamp(5) }];
  state.signals = [];
  state.uploads = [];
  state.audits = [];
  state.windows.clear();
  state.metrics = [];
});

async function consoleCookie(id) {
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id, role: ACCOUNTS.get(id).role }))}`;
}
async function studentCookie(id) {
  return `${STUDENT_SESSION_COOKIE}=${encodeURIComponent(await createStudentSession(id))}`;
}
function consoleRequest(method, cookie, body) {
  return new Request("https://console.example.test/api/console/cinema", {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("a report is filed once per room and folded while it stays open", async () => {
  const first = await fileCinemaReport({ sessionId: "room-1", sessionTitle: "Signals", reporter: { id: "student-a", name: "Ama" }, reason: "The host is sharing something else." });
  assert.equal(first.reportCount, 1);
  assert.equal(first.severity, "LOW");

  // The same student reporting again is the same report, not a second one.
  const repeated = await fileCinemaReport({ sessionId: "room-1", sessionTitle: "Signals", reporter: { id: "student-a", name: "Ama" }, reason: "Still going." });
  assert.equal(repeated.signalId, first.signalId);
  assert.equal(repeated.reportCount, 1);

  const second = await fileCinemaReport({ sessionId: "room-1", sessionTitle: "Signals", reporter: { id: "student-b", name: "Kwesi" } });
  assert.equal(second.signalId, first.signalId, "one open card per room");
  assert.equal(second.reportCount, 2);
  assert.equal(second.severity, "MEDIUM", "a second student raises the card");
  assert.equal(state.signals.length, 1);
});

test("a message report carries the excerpt and must belong to the room", async () => {
  const report = await fileCinemaReport({
    sessionId: "room-1", sessionTitle: "Signals", reporter: { id: "student-a", name: "Ama" },
    messageId: "message-1", reason: "This is off topic",
  });
  const signal = state.signals.find((entry) => entry.id === report.signalId);
  assert.equal(signal.entity_type, "MESSAGE");
  assert.equal(signal.entity_id, "message-1");
  assert.match(signal.evidence, /This is off topic/);
  assert.equal(signal.reporter_id, "student-a");

  await assert.rejects(
    () => fileCinemaReport({ sessionId: "room-2", sessionTitle: "Elsewhere", reporter: { id: "student-a" }, messageId: "message-1" }),
    (error) => error?.code === "NOT_FOUND",
  );
});

test("repeated reports from different students raise the severity", async () => {
  for (const id of ["student-a", "student-b", "student-c", "student-d"]) {
    await fileCinemaReport({ sessionId: "room-1", sessionTitle: "Signals", reporter: { id, name: id } });
  }
  const [signal] = await listCinemaSignals({ status: "OPEN" });
  assert.equal(signal.reportCount, 4);
  assert.equal(signal.severity, "HIGH");
});

test("closing a report needs a note and records who decided", async () => {
  const report = await fileCinemaReport({ sessionId: "room-1", sessionTitle: "Signals", reporter: { id: "student-a", name: "Ama" } });
  await assert.rejects(() => resolveCinemaSignal({ signalId: report.signalId, action: "REVIEW", note: "  ", actor: "mod@umat.edu.gh" }), (error) => error?.code === "VALIDATION_ERROR");
  const resolved = await resolveCinemaSignal({ signalId: report.signalId, action: "REVIEW", note: "Talked to the host.", actor: "mod@umat.edu.gh" });
  assert.equal(resolved.status, "REVIEWED");
  assert.equal(state.audits.at(-1).action, "cinema_signal_reviewed");
  await assert.rejects(() => resolveCinemaSignal({ signalId: report.signalId, action: "DISMISS", note: "again", actor: "mod@umat.edu.gh" }), (error) => error?.code === "INVALID_STATE");
});

test("the staff room list filters by state and search, and is not the student lobby", async () => {
  state.sessions = [
    session({ id: "live-1", title: "Live room", status: "LIVE", host_name: "Ama" }),
    session({ id: "open-1", title: "Waiting room", status: "CREATED", host_name: "Kwesi" }),
    session({ id: "ended-1", title: "Yesterday", status: "ENDED", ended_at: stamp(500), host_name: "Adwoa" }),
  ];
  const live = await listRoomsForConsole({ status: "ACTIVE" });
  assert.deepEqual(live.map((room) => room.id).sort(), ["live-1", "open-1"]);
  const ended = await listRoomsForConsole({ status: "ENDED" });
  assert.deepEqual(ended.map((room) => room.id), ["ended-1"]);
  const searched = await listRoomsForConsole({ status: "ALL", q: "Kwesi" });
  assert.deepEqual(searched.map((room) => room.id), ["open-1"], "a host name finds a room without a membership row for the reader");
});

test("a moderator ends an open room, once, with an audit row", async () => {
  const result = await endRoomAsStaff({ roomId: "room-1", actor: "mod@umat.edu.gh" });
  assert.equal(result.status, "ENDED");
  assert.equal(state.sessions[0].status, "ENDED");
  assert.ok(state.sessions[0].ended_at);
  assert.equal(state.audits.at(-1).action, "cinema_room_ended");
  assert.equal(state.audits.at(-1).actor, "mod@umat.edu.gh");
  await assert.rejects(() => endRoomAsStaff({ roomId: "room-1", actor: "mod@umat.edu.gh" }), (error) => error?.code === "INVALID_STATE");
});

test("a message can only be removed from the room it belongs to", async () => {
  await assert.rejects(() => removeCinemaMessage("message-1", "room-2"), (error) => error?.code === "NOT_FOUND");
  assert.equal(state.messages.length, 1, "the wrong room's request removed nothing");
  const removed = await removeCinemaMessage("message-1", "room-1");
  assert.equal(removed.id, "message-1");
  assert.equal(state.messages.length, 0);
});

test("the console APIs are staff-only", async () => {
  const anonymous = await sessionsRoute.GET(consoleRequest("GET"));
  assert.equal(anonymous.status, 401);
  const organizer = await sessionsRoute.GET(consoleRequest("GET", await consoleCookie("console-organizer")));
  assert.equal(organizer.status, 403);

  const endBlocked = await sessionRoute.POST(
    new Request("https://console.example.test/api/console/cinema/sessions/room-1", { method: "POST", headers: { cookie: await consoleCookie("console-organizer"), "content-type": "application/json" }, body: JSON.stringify({ action: "END_ROOM" }) }),
    { params: Promise.resolve({ id: "room-1" }) },
  );
  assert.equal(endBlocked.status, 403);
  assert.equal(state.sessions[0].status, "LIVE", "a refused role changed nothing");
});

test("a moderator ends a room and removes a message through the console API", async () => {
  const cookie = await consoleCookie("console-moderator");
  const ended = await sessionRoute.POST(
    new Request("https://console.example.test/api/console/cinema/sessions/room-1", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "END_ROOM" }) }),
    { params: Promise.resolve({ id: "room-1" }) },
  );
  assert.equal(ended.status, 200);
  assert.equal(state.sessions[0].status, "ENDED");
  assert.match(state.audits.at(-1).details, /Signals/);

  const removed = await sessionRoute.POST(
    new Request("https://console.example.test/api/console/cinema/sessions/room-1", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "REMOVE_MESSAGE", messageId: "message-1" }) }),
    { params: Promise.resolve({ id: "room-1" }) },
  );
  assert.equal(removed.status, 200);
  assert.equal(state.messages.length, 0);
  assert.equal(state.audits.at(-1).action, "cinema_message_removed");
});

test("the signals API lists open reports and closes one", async () => {
  const cookie = await consoleCookie("console-admin");
  const report = await fileCinemaReport({ sessionId: "room-1", sessionTitle: "Signals", reporter: { id: "student-a", name: "Ama" } });
  const listed = await signalsRoute.GET(consoleRequest("GET", cookie));
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.signals.length, 1);
  assert.equal(body.summary.open, 1);

  const closed = await signalsRoute.POST(consoleRequest("POST", cookie, { action: "DISMISS", signalId: report.signalId, note: "No rule broken." }));
  assert.equal(closed.status, 200);
  const after = await (await signalsRoute.GET(consoleRequest("GET", cookie))).json();
  assert.equal(after.signals.length, 0);
});

test("a student in the room can report; a stranger cannot", async () => {
  const member = new Request("https://umatexpress.example.test/api/cinema/sessions/room-1/report", {
    method: "POST",
    headers: { cookie: await studentCookie("student-a"), "content-type": "application/json" },
    body: JSON.stringify({ messageId: "message-1", reason: "Off topic" }),
  });
  const filed = await reportRoute.POST(member, { params: Promise.resolve({ id: "room-1" }) });
  assert.equal(filed.status, 201);
  assert.equal((await filed.json()).report.reportCount, 1);

  const stranger = new Request("https://umatexpress.example.test/api/cinema/sessions/room-1/report", {
    method: "POST",
    headers: { cookie: await studentCookie("student-b"), "content-type": "application/json" },
    body: JSON.stringify({ reason: "Not in this room" }),
  });
  const refused = await reportRoute.POST(stranger, { params: Promise.resolve({ id: "room-1" }) });
  assert.equal(refused.status, 403, "reporting is something said from inside the room");
});

test("a moderator takes an uploaded video down through the console API", async () => {
  state.sessions[0].video_source_type = "UPLOAD";
  state.sessions[0].video_id = "upload-1";
  state.uploads = [{
    id: "upload-1", session_id: "room-1", uploader_id: "student-a", r2_object_key: "cinema/room-1/video/upload-1/original.mp4",
    r2_upload_id: "", original_filename: "party.mp4", file_size_bytes: 1024, mime_type: "video/mp4", duration_seconds: 30,
    ownership_confirmed: 1, status: "READY", expires_at: "", deleted_at: "", removed_by: "", removed_reason: "",
    created_at: stamp(30), updated_at: stamp(5),
  }];

  const moderator = await consoleCookie("console-moderator");
  const organizer = await consoleCookie("console-organizer");
  const student = await studentCookie("student-a");
  const call = (cookie, body) => sessionRoute.POST(
    new Request("https://console.example.test/api/console/cinema/sessions/room-1", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "room-1" }) },
  );

  assert.equal((await call(organizer, { action: "REMOVE_VIDEO" })).status, 403, "an organizer is not a moderator");
  assert.equal((await call(student, { action: "REMOVE_VIDEO" })).status, 401, "a student cookie is not a console session");
  assert.equal(state.uploads[0].status, "READY", "a refused caller changed nothing");

  const removed = await call(moderator, { action: "REMOVE_VIDEO", reason: "Copyright complaint" });
  assert.equal(removed.status, 200);
  const body = await removed.json();
  assert.equal(body.removal.uploaderRemovals, 1);
  assert.equal(body.removal.filename, "party.mp4");
  assert.equal(state.uploads[0].status, "DELETED");
  assert.equal(state.uploads[0].removed_by, "mod@umat.edu.gh");
  assert.equal(state.sessions[0].video_source_type, "YOUTUBE");
  assert.equal(state.sessions[0].video_id, "");
  assert.equal(state.audits.at(-1).action, "cinema_upload_removed");
  assert.equal(JSON.parse(state.audits.at(-1).details).reason, "Copyright complaint");

  assert.equal((await call(moderator, { action: "REMOVE_VIDEO" })).status, 409, "a second takedown reports the truth");
});
