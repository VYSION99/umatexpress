import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";
process.env.TURSO_DATABASE_URL = "https://cinema-private-study.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
const sql = sqliteTurso(), originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await sql.fetch(...args);
  return Response.json(JSON.parse(JSON.stringify(await response.json(), (key, value) => key === "value" && typeof value === "number" ? String(value) : value)));
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const transcripts = await vite.ssrLoadModule("/lib/cinema-engine/transcripts.ts");
const messages = await vite.ssrLoadModule("/lib/cinema-engine/messages.ts");
const ai = await vite.ssrLoadModule("/lib/cinema-engine/chat-assistant.ts");
const privateStudy = await vite.ssrLoadModule("/lib/cinema-engine/private-study.ts");
let serial = 0;
async function fixture(enabled = true) {
  const host = { id: `host-${++serial}`, name: "Ama" }, guest = { id: `guest-${serial}`, name: "Kojo" };
  const room = await rooms.createRoom({ student: host, video: "dQw4w9WgXcQ", title: "Mechanics" });
  await rooms.joinRoom({ id: room.id, student: guest });
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: enabled });
  const video = { sourceType: "YOUTUBE", videoId: room.videoId };
  const write = (content, extra = {}) => messages.writeCinemaMessage({ sessionId: room.id, sender: host, content, video, atSeconds: 12, ...extra });
  return { room, host, guest, video, write,
    request: message => ai.requestCinemaAssistant({ roomId: room.id, studentId: host.id, messageId: message.id, configured: true }),
    jobs: async () => (await ai.listCinemaAssistantJobs(room.id, host.id)).jobs,
  };
}
const generate = async (_system, context) => JSON.stringify({ answer: "Inertia resists changes in motion, according to the room source.", citations: [JSON.parse(context).sources[0].key] });
async function request(f, question = "Explain inertia simply.", extra = {}) {
  return privateStudy.requestCinemaPrivateStudy({ roomId: f.room.id, ownerId: f.host.id, requestId: crypto.randomUUID(), question, configured: true, ...extra });
}
const own = (f, job, ownerId = f.host.id) => ({ roomId: f.room.id, ownerId, id: job.id });

test("private questions and answers never enter shared history or shared job views", async () => {
  const f = await fixture(), anchor = await f.write("Inertia resists a change in motion.");
  const job = await request(f, "PRIVATE QUESTION: help me understand inertia", { ownerId: f.guest.id, anchorId: anchor.id });
  assert.equal(job.status, "QUEUED");
  const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate, roomId: f.room.id });
  assert.equal(result.status, "DONE"); assert.equal(result.citations[0].id, anchor.id);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_messages WHERE session_id=?").get(f.room.id).n, 1);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_message_order WHERE session_id=?").get(f.room.id).n, 1);
  assert.deepEqual((await ai.listCinemaAssistantJobs(f.room.id, f.host.id)).jobs, []);
  assert.equal(JSON.stringify(await messages.recentCinemaMessages(f.room.id)).includes("PRIVATE QUESTION"), false);
});
test("room hosts and other members cannot read, retry, cancel, delete or inspect another owner's private request", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes.");
  const job = await request(f, "My private question", { ownerId: f.guest.id });
  await privateStudy.processCinemaPrivateStudy(job.id, { generate });
  assert.equal((await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests.length, 0);
  assert.equal((await privateStudy.listCinemaPrivateStudy(f.room.id, f.guest.id)).requests[0].question, "My private question");
  for (const action of ["RETRY", "CANCEL"]) await assert.rejects(privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action, configured: true }), error => error.status === 404);
  await assert.rejects(privateStudy.deleteCinemaPrivateStudy(own(f, job)), error => error.status === 404);
  await assert.rejects(privateStudy.readCinemaPrivateStudySource({ ...own(f, job), key: "M1" }), error => error.status === 404);
  const source = await privateStudy.readCinemaPrivateStudySource({ ...own(f, job, f.guest.id), key: "M1" }); assert.match(source.text, /Inertia/);
  await assert.rejects(privateStudy.listCinemaPrivateStudy(f.room.id, "outsider"), error => error.status === 403);
});
test("private sources and request IDs cannot cross room boundaries", async () => {
  const f = await fixture(), other = await fixture(), anchor = await other.write("OTHER ROOM SECRET");
  await assert.rejects(request(f, "Explain this", { anchorId: anchor.id }), error => error.status === 404);
  const job = await request(f);
  assert.equal(await privateStudy.processCinemaPrivateStudy(job.id, { roomId: other.room.id, generate }), null);
  await assert.rejects(privateStudy.deleteCinemaPrivateStudy({ roomId: other.room.id, ownerId: other.host.id, id: job.id }), error => error.status === 404);
});
test("private request retries preserve identity and deleted requests cannot be resurrected", async () => {
  const f = await fixture(), requestId = crypto.randomUUID();
  const first = await request(f, "First private text", { requestId });
  const second = await request(f, "Changed text with the same delivery ID", { requestId });
  assert.equal(first.id, second.id); assert.equal(second.question, "First private text");
  await privateStudy.deleteCinemaPrivateStudy(own(f, first));
  await assert.rejects(request(f, "First private text", { requestId }), error => error.status === 404);
  const row = sql.db.prepare("SELECT * FROM cinema_private_study_requests WHERE id=?").get(first.id);
  assert.equal(row.status, "DELETED"); assert.equal(row.question, ""); assert.equal(row.answer, ""); assert.equal(row.video_context, "");
  assert.equal((await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests.length, 0);
});
test("an anchored explanation retains the selected video's context and the original sequence boundary", async () => {
  const f = await fixture(), anchor = await f.write("Inertia resists a change in motion.");
  sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id);
  await f.write("WRONG VIDEO SECRET", { video: { sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" } });
  const job = await request(f, "Explain inertia simply", { anchorId: anchor.id });
  await f.write("LATE SECRET");
  const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate: async (system, context) => {
    assert.match(system, /untrusted/); assert.doesNotMatch(context, /SECRET/); return generate(system, context);
  } });
  assert.equal(result.citations[0].id, anchor.id); assert.equal(result.citations[0].video.videoId, f.video.videoId);
});
test("a private question never becomes evidence for another participant's explanation", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes.");
  const guest = await request(f, "PRIVATE GUEST SECRET", { ownerId: f.guest.id });
  await privateStudy.processCinemaPrivateStudy(guest.id, { generate });
  const host = await request(f, "Explain inertia");
  const result = await privateStudy.processCinemaPrivateStudy(host.id, { generate: async (system, context) => { assert.doesNotMatch(context, /PRIVATE GUEST SECRET/); return generate(system, context); } });
  assert.equal(result.status, "DONE");
});
test("a selected @Cinema question can be explained privately without becoming a new shared question", async () => {
  const f = await fixture(), anchor = await f.write("@Cinema explain inertia");
  const job = await request(f, "Help me unpack this question", { anchorId: anchor.id });
  const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate: async (system, context) => {
    assert.equal(JSON.parse(context).sources[0].text, anchor.content); return generate(system, context);
  } });
  assert.equal(result.status, "DONE"); assert.equal(result.citations[0].id, anchor.id);
});
test("public and private requests share active-request fences and hourly allowances", async () => {
  const f = await fixture(), publicQuestion = await f.write("@Cinema explain inertia");
  const job = await request(f);
  await assert.rejects(f.request(publicQuestion), error => error.status === 429);
  await privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action: "CANCEL" });
  await f.request(publicQuestion);
  await assert.rejects(request(f), error => error.status === 429);
});
test("deleting private payloads does not reset the per-member usage budget", async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i++) { const job = await request(f, `Private question ${i}`); await privateStudy.deleteCinemaPrivateStudy(own(f, job)); }
  await assert.rejects(request(f), error => error.status === 429);
  const publicQuestion = await f.write("@Cinema explain inertia"); await assert.rejects(f.request(publicQuestion), error => error.status === 429);
});
test("unknown citations fail privately and retry errors never contain provider text", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const job = await request(f);
  assert.equal(await privateStudy.processCinemaPrivateStudy(job.id, { generate: async () => JSON.stringify({ answer: "Invented", citations: ["M999"] }) }), null);
  let current = (await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests[0]; assert.equal(current.status, "FAILED"); assert.equal(current.answer, "");
  await privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action: "RETRY", configured: true });
  await privateStudy.processCinemaPrivateStudy(job.id, { generate: async () => { throw new Error("PROVIDER PRIVATE SECRET"); } });
  current = (await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests[0]; assert.doesNotMatch(current.error, /SECRET/);
  await privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action: "RETRY", configured: true });
  const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate }); assert.equal(result.status, "DONE"); assert.equal(result.attempts, 3);
  await assert.rejects(privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action: "RETRY", configured: true }), error => error.status === 409);
});
test("cancelling or deleting during model work fences its late result", async () => {
  for (const action of ["CANCEL", "DELETE"]) {
    const f = await fixture(); await f.write("Inertia resists motion changes."); const job = await request(f);
    const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate: async (system, context) => {
      if (action === "DELETE") await privateStudy.deleteCinemaPrivateStudy(own(f, job));
      else await privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action });
      return generate(system, context);
    } });
    assert.equal(result, null);
    assert.equal(sql.db.prepare("SELECT answer FROM cinema_private_study_requests WHERE id=?").get(job.id).answer, "");
  }
});
test("reclaimed private jobs cannot publish an old worker's result", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const job = await request(f);
  let replacement;
  const first = await privateStudy.processCinemaPrivateStudy(job.id, { generate: async (system, context) => {
    sql.db.prepare("UPDATE cinema_private_study_requests SET lease_until='2000-01-01' WHERE id=?").run(job.id);
    replacement = await privateStudy.processCinemaPrivateStudy(job.id, { generate }); return generate(system, context);
  } });
  assert.equal(first, null); assert.equal(replacement.status, "DONE"); assert.equal(replacement.attempts, 2);
});
test("membership, AI consent and all source inputs are rechecked after generation", async () => {
  for (const change of ["membership", "consent", "source"]) {
    const f = await fixture(); await f.write("Inertia resists motion changes."); const uncited = await f.write("A participant challenged that claim.");
    const job = await request(f, "Explain inertia", { ownerId: f.guest.id });
    const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate: async (system, context) => {
      if (change === "membership") sql.db.prepare("DELETE FROM cinema_participants WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id);
      else if (change === "consent") await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: true, aiStudyEnabled: false });
      else await messages.removeCinemaMessage(uncited.id, f.room.id);
      return generate(system, context);
    } });
    assert.equal(result, null); assert.equal(sql.db.prepare("SELECT status,answer FROM cinema_private_study_requests WHERE id=?").get(job.id).status, "CANCELLED");
  }
});
test("moderation removes saved private derived text, including uncited dependencies", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const uncited = await f.write("A participant challenged that explanation.");
  const job = await request(f); const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate }); assert.equal(result.citations.length, 1);
  await messages.removeCinemaMessage(uncited.id, f.room.id);
  const current = (await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests[0];
  assert.equal(current.status, "CANCELLED"); assert.equal(current.answer, ""); assert.deepEqual(current.citations, []);
});
test("transcript clearing invalidates private explanations that used its evidence", async () => {
  const f = await fixture(); await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 });
  const job = await request(f); const result = await privateStudy.processCinemaPrivateStudy(job.id, { generate }); assert.equal(result.citations[0].kind, "TRANSCRIPT");
  await transcripts.clearCinemaTranscript(f.room.id, f.host.id);
  const current = (await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests[0]; assert.equal(current.answer, ""); assert.equal(current.status, "CANCELLED");
});
test("expired private requests are unreadable immediately and removed by scheduled retention", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const job = await request(f); await privateStudy.processCinemaPrivateStudy(job.id, { generate });
  sql.db.prepare("UPDATE cinema_private_study_requests SET expires_at='2000-01-01' WHERE id=?").run(job.id);
  assert.equal((await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests.length, 0);
  await assert.rejects(privateStudy.readCinemaPrivateStudySource({ ...own(f, job), key: "M1" }), error => error.status === 404);
  const { runCinemaCleanup } = await vite.ssrLoadModule("/lib/cinema-engine/cleanup.ts");
  assert.equal((await runCinemaCleanup({ presence: async () => ({ roomId: f.room.id, memberCount: 1, emptySince: 0 }) })).configured, true);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_requests WHERE id=?").get(job.id).n, 0);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_evidence WHERE request_id=?").get(job.id).n, 0);
});
test("room retention purges private questions, answers and evidence", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const job = await request(f); await privateStudy.processCinemaPrivateStudy(job.id, { generate });
  await messages.purgeCinemaMessages(f.room.id);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_requests WHERE session_id=?").get(f.room.id).n, 0);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_evidence WHERE request_id=?").get(job.id).n, 0);
});
test("private Durable Object work never broadcasts private questions, results or statuses", async () => {
  const f = await fixture(), job = await request(f, "PRIVATE SOCKET SECRET");
  const events = [], tasks = [];
  const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");
  const object = new CinemaRoom({ storage: { get: async () => undefined, put: async () => {} }, getWebSockets: () => [{ send: frame => events.push(JSON.parse(frame)) }], acceptWebSocket() {}, waitUntil: promise => tasks.push(promise) });
  const response = await object.fetch(new Request("https://cinema-room/private-study-run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: job.id, roomId: f.room.id }) }));
  assert.equal(response.status, 202); await Promise.all(tasks);
  assert.deepEqual(events, []); assert.equal((await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests[0].status, "DONE");
});
test("private generation requires host consent and configured AI, while stale video references are rejected", async () => {
  const f = await fixture(false), job = await request(f);
  assert.equal(job.status, "FAILED"); assert.match(job.error, /host/);
  await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: true, aiStudyEnabled: true });
  const retry = await privateStudy.changeCinemaPrivateStudy({ ...own(f, job), action: "RETRY", configured: false }); assert.equal(retry.status, "FAILED"); assert.match(retry.error, /not configured/);
  await assert.rejects(request(f, "A new question", { expectedVideo: { sourceType: "UPLOAD", videoId: "wrong-source" } }), error => error.status === 409);
});
test("private and public requests also share the room-wide hourly budget", async () => {
  const f = await fixture(), stamp = new Date().toISOString();
  const insert = sql.db.prepare("INSERT INTO cinema_private_study_requests(id,session_id,owner_id,question,through_sequence,status,created_at,updated_at,expires_at) VALUES (?,?,?,'',0,'DELETED',?,?,?)");
  for (let i = 0; i < 30; i++) insert.run(`room-limit-${f.room.id}-${i}`, f.room.id, `other-${i}`, stamp, stamp, new Date(Date.now() + 86400000).toISOString());
  await assert.rejects(request(f), error => error.status === 429);
  const publicQuestion = await f.write("@Cinema explain inertia"); await assert.rejects(f.request(publicQuestion), error => error.status === 429);
});
test("expired transcript dependencies clear private derived text during retention", async () => {
  const f = await fixture(); const segment = await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 });
  const job = await request(f); await privateStudy.processCinemaPrivateStudy(job.id, { generate });
  sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(segment.id);
  const { runCinemaCleanup } = await vite.ssrLoadModule("/lib/cinema-engine/cleanup.ts");
  assert.equal((await runCinemaCleanup({ presence: async () => ({ roomId: f.room.id, memberCount: 1, emptySince: 0 }) })).configured, true);
  const current = (await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests[0]; assert.equal(current.status, "CANCELLED"); assert.equal(current.answer, "");
});
const personalNotes = await vite.ssrLoadModule("/lib/cinema-engine/personal-notes.ts");
function noteStorage() { const map = new Map(); return { map, getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) }; }
test("local notes isolate accounts and rooms and leave legacy device notes untouched", () => {
  const storage = noteStorage(); storage.setItem(personalNotes.cinemaLegacyNotesKey("room"), "EARLIER DEVICE TEXT");
  personalNotes.writeCinemaPersonalNotes(storage, "room", "account-a", "PRIVATE A");
  assert.equal(personalNotes.readCinemaPersonalNotes(storage, "room", "account-a"), "PRIVATE A");
  assert.equal(personalNotes.readCinemaPersonalNotes(storage, "room", "account-b"), "");
  assert.equal(personalNotes.readCinemaPersonalNotes(storage, "other", "account-a"), "");
  assert.equal(storage.getItem(personalNotes.cinemaLegacyNotesKey("room")), "EARLIER DEVICE TEXT");
  personalNotes.appendCinemaPersonalNotes(storage, "room", "account-a", "SAVED EXPLANATION");
  assert.equal(personalNotes.readCinemaPersonalNotes(storage, "room", "account-a"), "PRIVATE A\n\nSAVED EXPLANATION");
});
test("appending an explanation cannot truncate existing local notes or exceed their capacity", () => {
  const storage = noteStorage(), text = "x".repeat(personalNotes.CINEMA_NOTES_MAX);
  personalNotes.writeCinemaPersonalNotes(storage, "room", "self", text);
  assert.throws(() => personalNotes.appendCinemaPersonalNotes(storage, "room", "self", "more"), /full/);
  assert.equal(personalNotes.readCinemaPersonalNotes(storage, "room", "self"), text);
});
test("blocked local storage reports failure instead of pretending an explanation was saved", () => {
  assert.throws(() => personalNotes.appendCinemaPersonalNotes({ getItem() { return "existing"; }, setItem() { throw new Error("Storage blocked"); } }, "room", "self", "new"), /Storage blocked/);
});
test("private HTTP endpoints authenticate the owner, reject stale account views, and never accept a body owner override", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes.");
  const job = await request(f, "HTTP OWNER SECRET", { ownerId: f.guest.id }); await privateStudy.processCinemaPrivateStudy(job.id, { generate });
  process.env.STUDENT_SESSION_SECRET = "cinema-private-test-session-secret-at-least-32-characters";
  const auth = await vite.ssrLoadModule("/lib/student-auth.ts"); await auth.ensureStudentAccountsTable();
  const stamp = new Date().toISOString();
  const insert = sql.db.prepare("INSERT INTO student_accounts(id,email,name,password_hash,password_salt,password_iterations,email_verified,active,created_at,updated_at) VALUES (?,?,?,'test','test',1,1,1,?,?)");
  for (const account of [f.host, f.guest]) insert.run(account.id, `${account.id}@st.umat.edu.gh`, account.name, stamp, stamp);
  const hostCookie = `${auth.STUDENT_SESSION_COOKIE}=${await auth.createStudentSession(f.host.id)}`, guestCookie = `${auth.STUDENT_SESSION_COOKIE}=${await auth.createStudentSession(f.guest.id)}`;
  const route = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/private-study/route.ts");
  const sourceRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/private-study/sources/route.ts");
  const context = { params: Promise.resolve({ id: f.room.id }) }, url = `https://example.test/api/cinema/sessions/${f.room.id}/private-study`;
  const guestResponse = await route.GET(new Request(url, { headers: { cookie: guestCookie, "x-cinema-account": f.guest.id } }), context);
  assert.equal(guestResponse.status, 200); assert.match(guestResponse.headers.get("cache-control"), /private.*no-store/);
  assert.equal((await guestResponse.json()).requests[0].question, "HTTP OWNER SECRET");
  const hostResponse = await route.GET(new Request(url, { headers: { cookie: hostCookie, "x-cinema-account": f.host.id } }), context);
  assert.deepEqual((await hostResponse.json()).requests, []);
  const stale = await route.GET(new Request(url, { headers: { cookie: hostCookie, "x-cinema-account": f.guest.id } }), context); assert.equal(stale.status, 409);
  const source = await sourceRoute.GET(new Request(`${url}/sources?request=${job.id}&key=M1`, { headers: { cookie: hostCookie, "x-cinema-account": f.host.id } }), context); assert.equal(source.status, 404);
  const forbiddenDelete = await route.DELETE(new Request(url, { method: "DELETE", headers: { cookie: hostCookie, "content-type": "application/json", "x-cinema-account": f.host.id }, body: JSON.stringify({ requestId: job.id, ownerId: f.guest.id }) }), context); assert.equal(forbiddenDelete.status, 404);
  const anonymous = await route.GET(new Request(url, { headers: { "x-cinema-account": f.guest.id } }), context); assert.equal(anonymous.status, 401);
  const deletion = await route.DELETE(new Request(url, { method: "DELETE", headers: { cookie: guestCookie, "content-type": "application/json", "x-cinema-account": f.guest.id }, body: JSON.stringify({ requestId: job.id }) }), context); assert.equal(deletion.status, 200);
});
