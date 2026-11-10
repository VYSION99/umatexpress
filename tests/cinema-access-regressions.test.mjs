import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://cinema-access-regressions.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
const sql = sqliteTurso(), originalFetch = globalThis.fetch, OriginalResponse = globalThis.Response;
let beforeStatement, afterStatement;
globalThis.fetch = async (...args) => {
  const statements = JSON.parse(args[1].body).requests.flatMap(request => request.type === "execute" ? [request.stmt.sql] : request.type === "batch" ? request.batch.steps.map(step => step.stmt.sql) : []);
  if (beforeStatement?.matches(statements)) {
    const hook = beforeStatement; beforeStatement = null;
    await hook.run();
  }
  const response = await sql.fetch(...args);
  if (afterStatement?.matches(statements)) { const hook = afterStatement; afterStatement = null; await hook.run(); }
  return response;
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; globalThis.Response = OriginalResponse; });
const auth = await vite.ssrLoadModule("/lib/student-auth.ts"); await auth.ensureStudentAccountsTable();
const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const transcripts = await vite.ssrLoadModule("/lib/cinema-engine/transcripts.ts");
const messages = await vite.ssrLoadModule("/lib/cinema-engine/messages.ts");
const polls = await vite.ssrLoadModule("/lib/cinema-engine/polls.ts");
const hostAi = await vite.ssrLoadModule("/lib/cinema-engine/host-assistance.ts");
const study = await vite.ssrLoadModule("/lib/cinema-engine/private-study.ts");
const uploads = await vite.ssrLoadModule("/lib/cinema-engine/uploads.ts");
const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");
const { matchesCinemaVideo } = await vite.ssrLoadModule("/lib/cinema-engine/video-reference.ts");
let serial = 0;
async function fixture() {
  const host = { id: `host-${++serial}`, name: "Host" }, guest = { id: `guest-${serial}`, name: "Guest" };
  const room = await rooms.createRoom({ student: host, video: "dQw4w9WgXcQ", title: "Review regression" });
  await rooms.joinRoom({ id: room.id, student: guest });
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: true });
  return { host, guest, room };
}
const caption = (f, text, source = "UPLOAD") => transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Host", text, atSeconds: 12, source });
const captions = f => transcripts.listCinemaCaptionWindow({ id: f.room.id, studentId: f.guest.id, atSeconds: 12 });
const draftInput = (f, draft) => ({ roomId: f.room.id, ownerId: f.host.id, id: draft.id });
const approve = (f, draft) => hostAi.applyCinemaHostAssistance({ ...draftInput(f, draft), displayName: "Host", question: "Approved question", options: ["A", "B"] });
async function draft(f) {
  await messages.writeCinemaMessage({ sessionId: f.room.id, sender: f.host, content: "Inertia resists changes in motion.", atSeconds: 12, video: { sourceType: "YOUTUBE", videoId: f.room.videoId } });
  const result = await hostAi.requestCinemaHostAssistance({ roomId: f.room.id, ownerId: f.host.id, kind: "POLL", requestId: crypto.randomUUID(), configured: true });
  await study.processCinemaPrivateStudy(result.id, { generate: async (_system, context) => JSON.stringify({ question: "Which topic?", options: ["Inertia", "Force"], citations: [JSON.parse(context).sources[0].key] }) });
  return result;
}

test("caption playback isolates video ID, source type, room and unbound legacy rows", async () => {
  const f = await fixture(), other = await fixture();
  await caption(f, "PREVIOUS VIDEO"); await caption(f, "PREVIOUS CALL", "CALL"); await caption(other, "OTHER ROOM");
  sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id);
  await caption(f, "SAME ID BUT DIFFERENT SOURCE");
  sql.db.prepare("UPDATE cinema_sessions SET video_source_type='UPLOAD' WHERE id=?").run(f.room.id);
  const current = await caption(f, "CURRENT VIDEO");
  sql.db.prepare("INSERT INTO cinema_transcript_segments(id,session_id,text,source,at_seconds,created_at) VALUES ('legacy-'||?,?,'UNBOUND LEGACY','UPLOAD',12,?)").run(f.room.id, f.room.id, new Date().toISOString());
  assert.deepEqual((await captions(f)).map(row => row.id), [current.id]);
  await assert.rejects(transcripts.listCinemaCaptionWindow({ id: f.room.id, studentId: f.guest.id, atSeconds: 12, expectedVideo: { sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" } }), error => error.status === 409);
});

test("expired transcripts are unreadable through full, search and caption reads before cleanup", async () => {
  const f = await fixture(), expired = await caption(f, "expired lesson"), current = await caption(f, "current lesson");
  sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(expired.id);
  for (const query of [undefined, "lesson"]) {
    assert.deepEqual((await transcripts.listCinemaTranscript({ id: f.room.id, studentId: f.guest.id, query })).map(row => row.id), [current.id]);
  }
  assert.deepEqual((await captions(f)).map(row => row.id), [current.id]);
  assert.ok(sql.db.prepare("SELECT id FROM cinema_transcript_segments WHERE id=?").get(expired.id), "expiry is enforced before physical deletion");
});

test("closing a poll fences both first votes and changes that were already in flight", async () => {
  for (const existing of [false, true]) {
    const f = await fixture(), poll = await polls.createCinemaPoll({ id: f.room.id, studentId: f.host.id, question: "Choose?", options: ["A", "B"], kind: "POLL" });
    const vote = optionIndex => polls.voteCinemaPoll({ id: f.room.id, studentId: f.guest.id, pollId: poll.id, optionIndex });
    if (existing) await vote(0);
    beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("INSERT INTO cinema_poll_votes")), run: () => polls.closeCinemaPoll({ id: f.room.id, studentId: f.host.id, pollId: poll.id }) };
    await assert.rejects(vote(1), error => error.status === 409);
    const result = (await polls.listCinemaPolls(f.room.id, f.host.id))[0];
    assert.equal(result.status, "CLOSED"); assert.deepEqual(result.votes, existing ? [1, 0] : [0, 0]);
  }
});

test("voting also fences room end and membership removal at the write boundary", async () => {
  for (const change of ["end", "remove"]) {
    const f = await fixture(), poll = await polls.createCinemaPoll({ id: f.room.id, studentId: f.host.id, question: "Choose?", options: ["A", "B"], kind: "POLL" });
    beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("INSERT INTO cinema_poll_votes")), run: () => change === "end"
      ? sql.db.prepare("UPDATE cinema_sessions SET status='ENDED' WHERE id=?").run(f.room.id)
      : sql.db.prepare("DELETE FROM cinema_participants WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id) };
    await assert.rejects(polls.voteCinemaPoll({ id: f.room.id, studentId: f.guest.id, pollId: poll.id, optionIndex: 1 }), error => error.status === 409);
    assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_poll_votes WHERE poll_id=?").get(poll.id).n, 0);
  }
});

test("approval winning a dismissal race preserves the draft, evidence and publication receipt", async () => {
  const f = await fixture(), suggestion = await draft(f);
  const evidenceCount = sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_evidence WHERE request_id=?").get(suggestion.id).n;
  beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("UPDATE cinema_private_study_requests SET status='DELETED'")), run: () => approve(f, suggestion) };
  await assert.rejects(hostAi.changeCinemaHostAssistance({ ...draftInput(f, suggestion), action: "DISMISS" }), error => error.status === 409);
  const visible = (await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts;
  assert.equal(visible.length, 1); assert.equal(visible[0].reviewStatus, "APPLIED"); assert.equal(visible[0].status, "DONE");
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_evidence WHERE request_id=?").get(suggestion.id).n, evidenceCount);
  assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 1);
  assert.deepEqual(await approve(f, suggestion), await approve(f, suggestion), "approval retries retain their receipt");
});

test("dismissal winning an approval race prevents publication", async () => {
  const f = await fixture(), suggestion = await draft(f);
  beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("INSERT OR IGNORE INTO cinema_polls")), run: () => hostAi.changeCinemaHostAssistance({ ...draftInput(f, suggestion), action: "DISMISS" }) };
  await assert.rejects(approve(f, suggestion), error => [404, 409].includes(error.status));
  assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
  assert.equal((await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts.length, 0);
});

function socket() { return { sent: [], serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; }, send(value) { this.sent.push(JSON.parse(value)); }, close(code) { this.closeCode = code; } }; }
globalThis.WebSocketPair = class { constructor() { return { 0: socket(), 1: socket() }; } };
globalThis.Response = class extends OriginalResponse {
  constructor(body, init) {
    if (init?.status !== 101) { super(body, init); return; }
    super(null, { status: 200, headers: init.headers }); Object.defineProperty(this, "status", { value: 101 }); this.webSocket = init.webSocket;
  }
};
async function connected(f) {
  sql.db.prepare("UPDATE cinema_sessions SET visibility='PRIVATE' WHERE id=?").run(f.room.id);
  const stored = new Map(), sockets = [];
  const state = { storage: { get: async key => stored.get(key), put: async (key, value) => stored.set(key, value) }, acceptWebSocket(peer) { sockets.push(peer); }, getWebSockets() { return sockets; } };
  const object = new CinemaRoom(state);
  const snapshot = { roomId: f.room.id, hostStudentId: f.host.id, title: "Regression", sourceType: "YOUTUBE", videoId: f.room.videoId };
  for (const actor of [f.host, f.guest]) await object.fetch(new Request("https://cinema-room/socket", { headers: { upgrade: "websocket", "x-cinema-attachment": encodeURIComponent(JSON.stringify({ studentId: actor.id, displayName: actor.name })), "x-cinema-room": encodeURIComponent(JSON.stringify(snapshot)) } }));
  return { object, sockets, state };
}

test("lost removal notifications cannot leave passive guests receiving private broadcasts", async () => {
  const f = await fixture(), { object, sockets } = await connected(f);
  // No DO namespace is configured: the actual removal API commits membership
  // deletion while its best-effort socket notification cannot be delivered.
  await rooms.removeRoomGuest({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id });
  await object.webSocketMessage(sockets[0], JSON.stringify({ type: "chat_message", message: "NEW PRIVATE SECRET" }));
  assert.equal(sockets[1].closeCode, 1000);
  assert.equal(sockets[1].sent.some(frame => frame.type === "chat" && frame.message.content === "NEW PRIVATE SECRET"), false);
  assert.equal((await object.presence()).some(member => member.studentId === f.guest.id), false);
  await object.webSocketMessage(sockets[1], JSON.stringify({ type: "chat_message", message: "POST AFTER REMOVAL" }));
  assert.equal((await messages.recentCinemaMessages(f.room.id)).some(message => message.content === "POST AFTER REMOVAL"), false);
});

test("a hibernated socket is revalidated before its next action and fails closed during storage outages", async () => {
  for (const unavailable of [false, true]) {
    const f = await fixture(), { sockets, state } = await connected(f);
    if (unavailable) beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("SELECT p.student_id")), run: () => { throw new Error("Database temporarily unavailable"); } };
    else sql.db.prepare("DELETE FROM cinema_participants WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id);
    const woken = new CinemaRoom(state);
    await woken.webSocketMessage(sockets[1], JSON.stringify({ type: "chat_message", message: "UNAUTHORIZED WRITE" }));
    assert.equal(sockets[1].closeCode, unavailable ? 1013 : 1000);
    assert.equal((await messages.recentCinemaMessages(f.room.id)).length, 0);
  }
});

test("removal during message persistence cannot store or acknowledge a new chat message", async () => {
  const f = await fixture(), { object, sockets } = await connected(f);
  sockets[1].sent.length = 0;
  beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("INSERT INTO cinema_messages")), run: () => sql.db.prepare("DELETE FROM cinema_participants WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id) };
  await object.webSocketMessage(sockets[1], JSON.stringify({ type: "chat_message", message: "REMOVED DURING WRITE", requestId: "revocation-race-123" }));
  assert.equal((await messages.recentCinemaMessages(f.room.id)).length, 0);
  assert.equal(sockets[1].sent.some(frame => frame.type === "chat_ack"), false);
});

test("quiz normalization preserves the selected answer across blank choices", async () => {
  const f = await fixture();
  const poll = await polls.createCinemaPoll({ id: f.room.id, studentId: f.host.id, question: "Pick B", options: [" ", " B ", "C"], kind: "QUIZ", correctIndex: 1 });
  await polls.closeCinemaPoll({ id: f.room.id, studentId: f.host.id, pollId: poll.id });
  const stored = (await polls.listCinemaPolls(f.room.id, f.host.id))[0];
  assert.deepEqual(stored.options, ["B", "C"]); assert.equal(stored.correctIndex, 0);
  for (const correctIndex of [0, -1, 5, 1.5, "not-a-number"]) await assert.rejects(polls.createCinemaPoll({ id: f.room.id, studentId: f.host.id, question: "Pick B", options: ["", "B", "C"], kind: "QUIZ", correctIndex }), error => error.status === 400);
});

test("bookmarks and transcript archives retain their original video and leave legacy references unbound", async () => {
  const f = await fixture(), video = { sourceType: "YOUTUBE", videoId: f.room.videoId };
  const bookmark = await rooms.addCinemaBookmark({ id: f.room.id, studentId: f.host.id, label: "Original moment", atSeconds: 12, expectedVideo: video });
  const segment = await caption(f, "Original video transcript");
  sql.db.prepare("INSERT INTO cinema_bookmarks(id,session_id,student_id,label,at_seconds,created_at) VALUES ('legacy-'||?, ?, ?, 'Unknown original video', 12, ?)").run(f.room.id, f.room.id, f.host.id, new Date().toISOString());
  sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id);
  const bookmarks = await rooms.listCinemaBookmarks({ id: f.room.id, studentId: f.guest.id });
  const transcript = await transcripts.listCinemaTranscript({ id: f.room.id, studentId: f.guest.id });
  assert.deepEqual(bookmarks.find(row => row.id === bookmark.id).video, video);
  assert.equal(bookmarks.find(row => row.id.startsWith("legacy-")).video, undefined);
  assert.deepEqual(transcript.find(row => row.id === segment.id).video, video);
  assert.equal(matchesCinemaVideo(video, { ...video, videoId: "M7lc1UVf-VE" }), false);
  assert.equal(matchesCinemaVideo(video, { ...video, sourceType: "UPLOAD" }), false);
  assert.equal(matchesCinemaVideo(undefined, video), false); assert.equal(matchesCinemaVideo(video, video), true);
  await assert.rejects(rooms.addCinemaBookmark({ id: f.room.id, studentId: f.host.id, label: "Stale", atSeconds: 12, expectedVideo: video }), error => error.status === 409);
  await rooms.deleteCinemaBookmark({ id: f.room.id, studentId: f.host.id, bookmarkId: bookmark.id });
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_bookmark_video_context WHERE bookmark_id=?").get(bookmark.id).n, 0);
});

test("bookmark video context is fenced at its write boundary", async () => {
  const f = await fixture();
  beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("INSERT INTO cinema_bookmarks")), run: () => sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id) };
  await assert.rejects(rooms.addCinemaBookmark({ id: f.room.id, studentId: f.host.id, label: "Race", atSeconds: 12, expectedVideo: { sourceType: "YOUTUBE", videoId: f.room.videoId } }), error => error.status === 409);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_bookmark_video_context WHERE session_id=?").get(f.room.id).n, 0);
});

test("timestamp seeks are rejected when the room selected a different video", async () => {
  const f = await fixture(), { object, sockets } = await connected(f);
  await object.webSocketMessage(sockets[0], JSON.stringify({ type: "seek", time: 99, video: { sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" } }));
  assert.match(sockets[0].sent.at(-1).message, /different video/);
  await object.webSocketMessage(sockets[0], JSON.stringify({ type: "seek", time: 12, video: { sourceType: "YOUTUBE", videoId: f.room.videoId } }));
  assert.equal(sockets[0].sent.at(-1).playback.positionSeconds, 12);
});

test("bookmark context migration is repeatable and room deletion purges context", async () => {
  const migration = await readFile(new URL("../sql/055_cinema_bookmark_video_context.sql", import.meta.url), "utf8");
  sql.db.exec(migration); sql.db.exec(migration);
  const f = await fixture();
  await rooms.addCinemaBookmark({ id: f.room.id, studentId: f.host.id, label: "Clean this moment", atSeconds: 12 });
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_bookmark_video_context WHERE session_id=?").get(f.room.id).n, 1);
  await rooms.deleteRoom({ id: f.room.id, studentId: f.host.id });
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_bookmark_video_context WHERE session_id=?").get(f.room.id).n, 0);
});

test("missed role notifications cannot preserve demoted privileges or block a fresh promotion", async () => {
  const f = await fixture();
  await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "COHOST" });
  const { object, sockets } = await connected(f);
  sockets[1].serializeAttachment({ ...sockets[1].deserializeAttachment(), mic: true, camera: true, screen: true });
  await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "VIEWER" });
  await object.webSocketMessage(sockets[1], JSON.stringify({ type: "seek", time: 91 }));
  assert.equal(sockets[1].sent.at(-1).type, "error");
  const member = (await object.presence()).find(row => row.studentId === f.guest.id);
  assert.equal(member.role, "VIEWER"); assert.equal(member.mic, false); assert.equal(member.camera, false); assert.equal(member.screen, false);
  await object.webSocketMessage(sockets[1], JSON.stringify({ type: "mute_all" }));
  assert.equal(sockets[1].sent.at(-1).type, "error");
  await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "COHOST" });
  await object.webSocketMessage(sockets[1], JSON.stringify({ type: "seek", time: 12 }));
  assert.equal(sockets[1].sent.at(-1).playback.positionSeconds, 12);
});

test("removal during a pending membership read does not reject another member's frame", async () => {
  const f = await fixture(), { object, sockets } = await connected(f);
  afterStatement = { matches: statements => statements.some(statement => statement.startsWith("SELECT p.student_id")), run: () => object.fetch(new Request("https://cinema-room/remove-member", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId: f.guest.id }) })) };
  await object.webSocketMessage(sockets[0], JSON.stringify({ type: "ping" }));
  assert.equal(sockets[0].sent.at(-1).type, "pong");
  assert.equal(sockets[1].deserializeAttachment(), null);
  await object.webSocketMessage(sockets[0], JSON.stringify({ type: "chat_message", message: "Room still works" }));
  assert.equal(sockets[0].sent.at(-1).message.content, "Room still works");
});

test("lost source notifications cannot authorize a timestamp against a stale socket snapshot", async () => {
  const f = await fixture(), { object, sockets } = await connected(f);
  sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id);
  const seek = videoId => object.webSocketMessage(sockets[0], JSON.stringify({ type: "seek", time: 99, video: { sourceType: "YOUTUBE", videoId } }));
  await seek(f.room.videoId); assert.equal(sockets[0].sent.at(-1).type, "error");
  await seek("M7lc1UVf-VE"); assert.equal(sockets[0].sent.at(-1).type, "error", "both durable and database selection must agree");
  await object.fetch(new Request("https://cinema-room/source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" }) }));
  await seek("M7lc1UVf-VE"); assert.equal(sockets[0].sent.at(-1).playback.positionSeconds, 99);
});

async function uploadFixture(plan) {
  const host = { id: `upload-host-${++serial}`, name: "Ama" };
  if (plan) {
    const { ensureCinemaRoomPlans } = await vite.ssrLoadModule("/lib/cinema-engine/room-plans.ts");
    await ensureCinemaRoomPlans();
    sql.db.prepare("INSERT INTO cinema_room_plan_grants(account_id,plan,updated_at) VALUES (?,?,?)").run(host.id, plan, new Date().toISOString());
  }
  const room = await rooms.createRoom({ student: host, title: "Upload publication", source: "UPLOAD" });
  const objects = new Map(), handles = new Map(), aborted = []; let beforeComplete, afterComplete;
  const bytes = new Uint8Array(52), view = new DataView(bytes.buffer);
  view.setUint32(0, 16); bytes.set(new TextEncoder().encode("ftyp"), 4);
  view.setUint32(16, 36); bytes.set(new TextEncoder().encode("moov"), 20);
  view.setUint32(24, 28); bytes.set(new TextEncoder().encode("mvhd"), 28);
  view.setUint32(44, 1000); view.setUint32(48, 30000);
  const bucket = {
    async createMultipartUpload(key) {
      const handle = { uploadId: "multipart-fixture", async uploadPart(partNumber) { return { partNumber, etag: "etag-1" }; }, async abort() { aborted.push(key); }, async complete() {
        if (beforeComplete) await beforeComplete(); objects.set(key, bytes);
        if (afterComplete) await afterComplete(); return { size: bytes.length };
      } }; handles.set(key, handle); return handle;
    },
    resumeMultipartUpload(key) { return handles.get(key); },
    async delete(key) { objects.delete(key); },
    async get(key) { const value = objects.get(key); return value ? { size: value.length, body: new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }) } : null; },
  };
  const begin = () => uploads.beginCinemaUpload({ roomId: room.id, studentId: host.id, filename: "lesson.mp4", sizeBytes: bytes.length, contentType: "video/mp4", ownershipConfirmed: true, bucket });
  const put = () => uploads.putCinemaUploadPart({ roomId: room.id, studentId: host.id, partNumber: 1, body: bytes.buffer, bucket });
  const started = await begin();
  await put();
  const complete = () => uploads.completeCinemaUpload({ roomId: room.id, studentId: host.id, parts: [{ partNumber: 1, etag: "etag-1" }], bucket });
  const cancel = () => uploads.abortCinemaUpload({ roomId: room.id, studentId: host.id, uploadId: started.upload.id, bucket });
  return { room, host, objects, aborted, started, begin, put, complete, cancel, before(fn) { beforeComplete = fn; }, after(fn) { afterComplete = fn; } };
}

test("Pro Plus reserves exactly 15 playlist slots even when two upload starts overlap", async () => {
  const f = await uploadFixture("PRO_PLUS");
  await f.complete();
  for (let slot = 2; slot <= 14; slot++) {
    const started = await f.begin();
    assert.equal(started.upload.playlistPosition, slot);
    await f.put();
    await f.complete();
  }
  let winner;
  beforeStatement = {
    matches: statements => statements.some(statement => statement.startsWith("INSERT INTO cinema_uploads")),
    run: async () => { winner = await f.begin(); await f.put(); await f.complete(); },
  };
  await assert.rejects(f.begin(), error => error.status === 409);
  assert.equal(winner.upload.playlistPosition, 15);
  assert.equal(f.aborted.length, 1, "the rejected multipart upload is cleaned up");
  const playlist = await uploads.cinemaUploadsForRoom(f.room.id);
  assert.deepEqual(playlist.map(video => video.playlistPosition), Array.from({ length: 15 }, (_, index) => index + 1));
  await assert.rejects(f.begin(), /allows 15 files/);
  assert.equal((await uploads.reorderCinemaPlaylist({ roomId: f.room.id, studentId: f.host.id, uploadIds: playlist.slice(1).map(video => video.id).reverse() })).uploads[1].id, winner.upload.id);
  assert.equal((await uploads.advanceCinemaPlaylist({ roomId: f.room.id, studentId: f.host.id, currentUploadId: playlist[0].id })).next.id, winner.upload.id);
});

test("advancement and reordering keep the next unplayed video in either write order", async () => {
  for (const advanceFirst of [true, false]) {
    const f = await uploadFixture("STUDENT_PLUS");
    await f.complete();
    const ids = [f.started.upload.id];
    for (let i = 0; i < 2; i++) {
      ids.push((await f.begin()).upload.id);
      await f.put(); await f.complete();
    }
    const advance = currentUploadId => uploads.advanceCinemaPlaylist({ roomId: f.room.id, studentId: f.host.id, currentUploadId });
    const reorder = () => uploads.reorderCinemaPlaylist({ roomId: f.room.id, studentId: f.host.id, uploadIds: [ids[2], ids[1]] });
    if (advanceFirst) {
      beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("UPDATE cinema_uploads SET playlist_position")), run: () => advance(ids[0]) };
      await assert.rejects(reorder(), error => error.status === 409);
      assert.equal((await advance(ids[1])).next.id, ids[2]);
    } else {
      beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("UPDATE cinema_sessions SET video_id = COALESCE")), run: reorder };
      assert.equal((await advance(ids[0])).next.id, ids[2]);
      assert.equal((await advance(ids[2])).next.id, ids[1]);
    }
  }
});

test("resumed parts and completion cannot modify a replacement upload", async () => {
  const f = await uploadFixture();
  await f.cancel();
  const replacement = await f.begin();
  const stale = { roomId: f.room.id, studentId: f.host.id, uploadId: f.started.upload.id };
  await assert.rejects(uploads.putCinemaUploadPart(stale), error => error.status === 409);
  await assert.rejects(uploads.completeCinemaUpload(stale), error => error.status === 409);
  assert.equal((await uploads.cinemaUploadsForRoom(f.room.id))[0].id, replacement.upload.id);
  await f.put();
  assert.equal((await f.complete()).upload.id, replacement.upload.id);
});

test("cancellation winning before or after multipart completion prevents publication and removes late objects", async () => {
  for (const timing of ["before", "after", "publication"]) {
    const f = await uploadFixture();
    if (timing === "publication") beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("UPDATE cinema_uploads SET status = 'READY'")), run: f.cancel };
    else f[timing](f.cancel);
    await assert.rejects(f.complete(), error => error.status === 409);
    assert.equal(sql.db.prepare("SELECT status FROM cinema_uploads WHERE id=?").get(f.started.upload.id).status, "FAILED");
    assert.equal((await rooms.readRoom({ id: f.room.id, studentId: f.host.id })).videoId, "");
    assert.equal(f.objects.size, 0, timing);
  }
});

test("completion winning while cancellation waits preserves its ready object and room selection", async () => {
  const f = await uploadFixture();
  beforeStatement = { matches: statements => statements.some(statement => statement.startsWith("UPDATE cinema_uploads SET status = 'FAILED'")), run: f.complete };
  assert.equal((await f.cancel()).aborted, false);
  assert.equal(sql.db.prepare("SELECT status FROM cinema_uploads WHERE id=?").get(f.started.upload.id).status, "READY");
  assert.equal((await rooms.readRoom({ id: f.room.id, studentId: f.host.id })).videoId, f.started.upload.id);
  assert.equal(f.objects.size, 1);
});
