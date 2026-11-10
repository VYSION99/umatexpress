import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";
process.env.TURSO_DATABASE_URL = "https://cinema-host-assistance.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
let beforePublication;
const sql = sqliteTurso(), originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (beforePublication && JSON.parse(args[1].body).requests.some(request => request.type === "batch" && request.batch.steps.some(step => /^INSERT OR IGNORE INTO cinema_(polls|messages)/.test(step.stmt.sql)))) { const hook = beforePublication; beforePublication = null; hook(); }
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
const hostAi = await vite.ssrLoadModule("/lib/cinema-engine/host-assistance.ts");
const polls = await vite.ssrLoadModule("/lib/cinema-engine/polls.ts");
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
const own = (f, draft, ownerId = f.host.id) => ({ roomId: f.room.id, ownerId, id: draft.id });
const generate = async (_system, context) => {
  const source = JSON.parse(context).sources[0].key;
  if (_system.includes("neutral opinion")) return JSON.stringify({ question: "Which topic needs another example?", options: ["Inertia", "Force"], citations: [source] });
  if (_system.includes("message patterns")) return JSON.stringify({ items: [{ observation: "Repeated wording may need context.", reminder: "Please keep the discussion focused and respectful.", citations: [source] }] });
  return JSON.stringify({ text: "How does the room's explanation of inertia relate to force?", citations: [source] });
};
async function request(f, kind = "POLL", extra = {}) {
  return hostAi.requestCinemaHostAssistance({ roomId: f.room.id, ownerId: f.host.id, requestId: crypto.randomUUID(), kind, brief: "Help the room discuss inertia.", configured: true, ...extra });
}
async function completed(f, kind = "POLL", generator = generate, extra = {}) {
  const draft = await request(f, kind, extra); await privateStudy.processCinemaPrivateStudy(draft.id, { roomId: f.room.id, generate: generator });
  return (await hostAi.listCinemaHostAssistance(f.room.id, extra.ownerId || f.host.id)).drafts.find(item => item.id === draft.id);
}
const edits = { question: "Host edited question", options: ["First choice", "Second choice"] };

test("only current hosts and co-hosts can request or inspect host suggestions", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion.");
  await assert.rejects(request(f, "POLL", { ownerId: f.guest.id }), error => error.status === 403);
  await assert.rejects(hostAi.listCinemaHostAssistance(f.room.id, f.guest.id), error => error.status === 403);
  await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "COHOST" });
  const cohost = await completed(f, "POLL", generate, { ownerId: f.guest.id }); assert.equal(cohost.status, "DONE");
  assert.equal((await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts.length, 0);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, cohost), displayName: "Ama", ...edits }), error => error.status === 404);
});
test("generated drafts never open polls, post chat or enter personal study history", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion.");
  const draft = await completed(f);
  assert.equal(draft.proposal.kind, "POLL"); assert.equal(draft.reviewStatus, "REVIEW");
  assert.equal((await polls.listCinemaPolls(f.room.id, f.guest.id)).length, 0);
  assert.equal((await messages.recentCinemaMessages(f.room.id)).length, 1);
  assert.deepEqual((await privateStudy.listCinemaPrivateStudy(f.room.id, f.host.id)).requests, []);
  assert.deepEqual((await ai.listCinemaAssistantJobs(f.room.id, f.host.id)).jobs, []);
  await assert.rejects(privateStudy.readCinemaPrivateStudySource({ ...own(f, draft), key: "M1" }), error => error.status === 404);
  await assert.rejects(privateStudy.deleteCinemaPrivateStudy(own(f, draft)), error => error.status === 404);
  const source = await privateStudy.readCinemaPrivateStudySource({ ...own(f, draft), key: "M1", hostDraft: true }); assert.match(source.text, /Inertia/);
});
test("explicit poll approval applies host edits once and records who reviewed it", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f);
  const first = await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: f.host.name, ...edits });
  const replay = await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: f.host.name, question: "Other edits", options: ["Other", "Values"] });
  assert.deepEqual(replay, first);
  const all = await polls.listCinemaPolls(f.room.id, f.guest.id); assert.equal(all.length, 1); assert.equal(all[0].question, edits.question); assert.deepEqual(all[0].options, edits.options); assert.equal(all[0].kind, "POLL"); assert.equal(all[0].correctIndex, -1); assert.equal(all[0].aiAssisted, true);
  const record = sql.db.prepare("SELECT * FROM cinema_host_assistance WHERE request_id=?").get(draft.id); assert.equal(record.review_status, "APPLIED"); assert.equal(record.reviewed_by, f.host.id);
  assert.equal(first.resultId.includes(draft.id), false, "public identifiers do not expose private draft IDs");
});
test("concurrent approvals create a single poll and acknowledge the same result", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f);
  const results = await Promise.all([hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", question: "Another valid question", options: ["A", "B"] })]);
  assert.deepEqual(results[0], results[1]); assert.equal((await polls.listCinemaPolls(f.room.id, f.guest.id)).length, 1);
});
test("a reviewed discussion prompt becomes an attributed, labelled room message without private metadata", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f, "PROMPT");
  const result = await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", text: "Host edited prompt: explain your reasoning." });
  const message = await messages.readCinemaMessage(result.resultId); assert.equal(message.senderId, f.host.id); assert.equal(message.content, "Host edited prompt: explain your reasoning."); assert.equal(message.aiAssisted, true); assert.equal(message.assistant, undefined);
  assert.equal(JSON.stringify(message).includes(draft.id), false); assert.equal(message.atSeconds, null);
});
test("moderation reads shared chat only and produces no penalties or actions until a reminder is reviewed", async () => {
  const f = await fixture(), other = await fixture(); const source = await f.write("Repeated post: please look at this topic."); await other.write("OTHER ROOM SECRET");
  await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "TRANSCRIPT SECRET", atSeconds: 12 });
  const personal = await privateStudy.requestCinemaPrivateStudy({ roomId: f.room.id, ownerId: f.guest.id, requestId: crypto.randomUUID(), question: "LEARNER PRIVATE SECRET", configured: true });
  await privateStudy.processCinemaPrivateStudy(personal.id, { generate: async (_system, context) => JSON.stringify({ answer: "Private learning answer.", citations: [JSON.parse(context).sources[0].key] }) });
  const pending = await request(f, "MODERATION"); await f.write("LATER SECRET");
  await privateStudy.processCinemaPrivateStudy(pending.id, { generate: async (system, context) => {
    assert.doesNotMatch(context, /SECRET/); assert.match(system, /Do not infer/);
    return JSON.stringify({ action: "DELETE", target: source.id, items: [{ observation: "Repeated wording may need context.", reminder: "Please keep messages constructive.", citations: [JSON.parse(context).sources[0].key], severity: "HIGH" }] });
  } });
  const draft = (await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts[0];
  assert.equal(draft.proposal.items[0].severity, undefined); assert.equal((await messages.readCinemaMessage(source.id)).removed, false);
  await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", itemIndex: 0, text: "Host reviewed reminder: please stay constructive." });
  assert.equal((await messages.readCinemaMessage(source.id)).removed, false);
  const member = sql.db.prepare("SELECT role FROM cinema_participants WHERE session_id=? AND student_id=?").get(f.room.id, f.guest.id); assert.equal(member.role, "VIEWER");
  assert.equal((await polls.listCinemaPolls(f.room.id, f.guest.id)).length, 0);
});
test("malformed polls, invented citations and oversized reminders fail before becoming reviewable", async () => {
  for (const output of [{ question: "A poll", options: ["Same", "same"], citations: ["M1"] }, { question: "A poll", options: ["One"], citations: ["M1"] }, { question: "A poll", options: ["One", "Two"], citations: ["M999"] }]) {
    const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f, "POLL", async () => JSON.stringify(output));
    assert.equal(draft.status, "FAILED"); assert.equal(draft.proposal, null); assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
  }
  const f = await fixture(); await f.write("Repeated post"); const draft = await completed(f, "MODERATION", async () => JSON.stringify({ items: [{ observation: "A pattern", reminder: "x".repeat(501), citations: ["M1"] }] })); assert.equal(draft.status, "FAILED");
});
test("invalid host edits preserve the unapproved draft and cannot create an artifact", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f);
  for (const invalid of [{ question: "", options: ["A", "B"] }, { question: "A question", options: ["Same", "Same"] }, { question: "x".repeat(241), options: ["A", "B"] }]) await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...invalid }), error => error.status === 400);
  assert.equal((await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts[0].reviewStatus, "REVIEW"); assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
});
test("permission loss during generation cancels the suggestion and blocks private-endpoint bypasses", async () => {
  const f = await fixture(); await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "COHOST" }); await f.write("Inertia resists changes in motion.");
  const pending = await request(f, "POLL", { ownerId: f.guest.id });
  const result = await privateStudy.processCinemaPrivateStudy(pending.id, { generate: async (system, context) => { await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "VIEWER" }); return generate(system, context); } });
  assert.equal(result, null); assert.equal(sql.db.prepare("SELECT status,answer FROM cinema_private_study_requests WHERE id=?").get(pending.id).status, "CANCELLED");
  await assert.rejects(privateStudy.readCinemaPrivateStudySource({ ...own(f, pending, f.guest.id), key: "M1", hostDraft: true }), error => error.status === 403);
});
test("source removal clears generated draft text and blocks later approval", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const uncited = await f.write("A participant challenged the explanation."); const draft = await completed(f);
  await messages.removeCinemaMessage(uncited.id, f.room.id);
  const current = (await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts[0]; assert.equal(current.status, "CANCELLED"); assert.equal(current.proposal, null);
  assert.equal(sql.db.prepare("SELECT answer FROM cinema_private_study_requests WHERE id=?").get(draft.id).answer, "");
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), error => error.status === 409);
});
test("AI consent is checked again inside the approval transaction", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f);
  beforePublication = () => sql.db.prepare("UPDATE cinema_session_privacy SET ai_study_enabled=0 WHERE session_id=?").run(f.room.id);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), error => error.status === 409);
  assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0); assert.equal(sql.db.prepare("SELECT review_status FROM cinema_host_assistance WHERE request_id=?").get(draft.id).review_status, "REVIEW");
});
test("host permission is checked again inside the approval transaction", async () => {
  const f = await fixture(); await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "COHOST" }); await f.write("Inertia resists changes in motion."); const draft = await completed(f, "POLL", generate, { ownerId: f.guest.id });
  beforePublication = () => sql.db.prepare("UPDATE cinema_participants SET role='VIEWER' WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft, f.guest.id), displayName: "Kojo", ...edits }), error => [403, 409].includes(error.status));
  assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
});
test("ended rooms reject new approval while acknowledging already committed actions", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f); const result = await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits });
  sql.db.prepare("UPDATE cinema_sessions SET status='ENDED' WHERE id=?").run(f.room.id);
  assert.deepEqual(await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), result);
  await assert.rejects(request(f), error => error.status === 403);
  const second = await fixture(); await second.write("Inertia resists changes in motion."); const unapproved = await completed(second); sql.db.prepare("UPDATE cinema_sessions SET status='ENDED' WHERE id=?").run(second.room.id);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(second, unapproved), displayName: "Ama", ...edits }), error => error.status === 409);
});
test("suggestions share AI allowances and dismissal keeps a content-free usage record", async () => {
  const f = await fixture(); const draft = await request(f); const publicQuestion = await f.write("@Cinema explain inertia");
  await assert.rejects(f.request(publicQuestion), error => error.status === 429);
  await hostAi.changeCinemaHostAssistance({ ...own(f, draft), action: "DISMISS" });
  const row = sql.db.prepare("SELECT question,answer,status FROM cinema_private_study_requests WHERE id=?").get(draft.id); assert.equal(row.question, ""); assert.equal(row.answer, ""); assert.equal(row.status, "DELETED");
  assert.equal(sql.db.prepare("SELECT review_status FROM cinema_host_assistance WHERE request_id=?").get(draft.id).review_status, "DISMISSED");
});
test("empty evidence skips model work and cannot be approved", async () => {
  const f = await fixture(); const draft = await completed(f, "POLL", () => { throw new Error("must not call a model"); });
  assert.equal(draft.status, "DONE"); assert.equal(draft.proposal, null);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), error => error.status === 409);
});
test("room retention removes draft review records and generated content together", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f); await messages.purgeCinemaMessages(f.room.id);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_host_assistance WHERE request_id=?").get(draft.id).n, 0);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_private_study_requests WHERE id=?").get(draft.id).n, 0);
});
test("approval also fences a source removed at the transaction boundary", async () => {
  const f = await fixture(), source = await f.write("Inertia resists changes in motion."); const draft = await completed(f);
  beforePublication = () => sql.db.prepare("DELETE FROM cinema_messages WHERE id=?").run(source.id);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), error => error.status === 409);
  assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
});
test("transcript consent revoked before review prevents publication", async () => {
  const f = await fixture(); await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 }); const draft = await completed(f);
  assert.equal(draft.citations[0].kind, "TRANSCRIPT");
  await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: false, aiStudyEnabled: true });
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), error => error.status === 403);
});
test("host retries retain their purpose and dismissal clears generated text", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f, "POLL", async () => "malformed"); assert.equal(draft.status, "FAILED");
  await hostAi.changeCinemaHostAssistance({ ...own(f, draft), action: "RETRY", configured: true }); await privateStudy.processCinemaPrivateStudy(draft.id, { generate });
  assert.equal((await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts[0].proposal.kind, "POLL");
  await hostAi.changeCinemaHostAssistance({ ...own(f, draft), action: "DISMISS" });
  assert.equal(sql.db.prepare("SELECT answer FROM cinema_private_study_requests WHERE id=?").get(draft.id).answer, ""); assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
});
test("overlapping workers keep the replacement suggestion and never apply it automatically", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await request(f);
  const old = await privateStudy.processCinemaPrivateStudy(draft.id, { generate: async (system, context) => {
    sql.db.prepare("UPDATE cinema_private_study_requests SET lease_until='2000-01-01' WHERE id=?").run(draft.id); await privateStudy.processCinemaPrivateStudy(draft.id, { generate }); return generate(system, context);
  } });
  assert.equal(old, null); const current = (await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts[0]; assert.equal(current.attempts, 2); assert.equal(current.reviewStatus, "REVIEW"); assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 0);
});
test("host worker completion has no socket output, even when the object has viewers", async () => {
  const f = await fixture(), draft = await request(f); const events = [], tasks = [];
  const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");
  const object = new CinemaRoom({ storage: { get: async () => undefined, put: async () => {} }, getWebSockets: () => [{ send: frame => events.push(JSON.parse(frame)) }], acceptWebSocket() {}, waitUntil: promise => tasks.push(promise) });
  await object.fetch(new Request("https://cinema-room/private-study-run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: draft.id, roomId: f.room.id }) })); await Promise.all(tasks);
  assert.deepEqual(events, []); assert.equal((await hostAi.listCinemaHostAssistance(f.room.id, f.host.id)).drafts[0].status, "DONE");
});
test("expired drafts and reviews are purged, and reusing an old delivery key cannot approve an older poll", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const requestId = crypto.randomUUID(), draft = await completed(f, "POLL", generate, { requestId }); const first = await hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits });
  sql.db.prepare("UPDATE cinema_private_study_requests SET expires_at='2000-01-01' WHERE id=?").run(draft.id);
  await assert.rejects(hostAi.applyCinemaHostAssistance({ ...own(f, draft), displayName: "Ama", ...edits }), error => error.status === 404);
  const { runCinemaCleanup } = await vite.ssrLoadModule("/lib/cinema-engine/cleanup.ts"); assert.equal((await runCinemaCleanup({ presence: async () => ({ memberCount: 1, emptySince: 0 }) })).configured, true);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_host_assistance WHERE request_id=?").get(draft.id).n, 0);
  const fresh = await completed(f, "POLL", generate, { requestId }); const second = await hostAi.applyCinemaHostAssistance({ ...own(f, fresh), displayName: "Ama", question: "New reviewed poll", options: ["New A", "New B"] });
  assert.notEqual(second.resultId, first.resultId); assert.equal((await polls.listCinemaPolls(f.room.id, f.host.id)).length, 2);
});
test("HTTP host endpoints reject viewers, stale account views, forged owners and unsupported moderation actions", async () => {
  const f = await fixture(); await f.write("Inertia resists changes in motion."); const draft = await completed(f);
  process.env.STUDENT_SESSION_SECRET = "cinema-host-test-session-secret-at-least-32-characters";
  const auth = await vite.ssrLoadModule("/lib/student-auth.ts"); await auth.ensureStudentAccountsTable();
  const stamp = new Date().toISOString(), insert = sql.db.prepare("INSERT INTO student_accounts(id,email,name,password_hash,password_salt,password_iterations,email_verified,active,created_at,updated_at) VALUES (?,?,?,'test','test',1,1,1,?,?)");
  for (const account of [f.host, f.guest]) insert.run(account.id, `${account.id}@st.umat.edu.gh`, account.name, stamp, stamp);
  const hostCookie = `${auth.STUDENT_SESSION_COOKIE}=${await auth.createStudentSession(f.host.id)}`, guestCookie = `${auth.STUDENT_SESSION_COOKIE}=${await auth.createStudentSession(f.guest.id)}`;
  const route = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/host-assistance/route.ts"), sourceRoute = await vite.ssrLoadModule("/app/api/cinema/sessions/[id]/host-assistance/sources/route.ts");
  const context = { params: Promise.resolve({ id: f.room.id }) }, url = `https://example.test/api/cinema/sessions/${f.room.id}/host-assistance`;
  const make = (cookie, actor, body) => new Request(url, { method: body ? "PATCH" : "GET", headers: { cookie, "content-type": "application/json", "x-cinema-account": actor }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const allowed = await route.GET(make(hostCookie, f.host.id), context); assert.equal(allowed.status, 200); assert.match(allowed.headers.get("cache-control"), /private.*no-store/); assert.equal((await allowed.json()).drafts.length, 1);
  assert.equal((await route.GET(make(guestCookie, f.guest.id), context)).status, 403);
  assert.equal((await route.GET(make(hostCookie, f.guest.id), context)).status, 409);
  assert.equal((await route.GET(new Request(url), context)).status, 401);
  const forged = await route.PATCH(make(guestCookie, f.guest.id, { requestId: draft.id, action: "APPLY", ownerId: f.host.id, ...edits }), context); assert.equal(forged.status, 403);
  const unknown = await route.PATCH(make(hostCookie, f.host.id, { requestId: draft.id, action: "MUTE_MEMBER", targetId: f.guest.id }), context); assert.equal(unknown.status, 400);
  const forbiddenSource = await sourceRoute.GET(new Request(`${url}/sources?request=${draft.id}&key=M1`, { headers: { cookie: guestCookie, "x-cinema-account": f.guest.id } }), context); assert.ok([403, 404].includes(forbiddenSource.status));
  const approved = await route.PATCH(make(hostCookie, f.host.id, { requestId: draft.id, action: "APPLY", displayName: "Forged sender", ...edits }), context); assert.equal(approved.status, 200);
  const result = (await approved.json()).result; assert.equal(sql.db.prepare("SELECT created_by FROM cinema_polls WHERE id=?").get(result.resultId).created_by, f.host.id);
});
