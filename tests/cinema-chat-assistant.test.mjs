import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";
process.env.TURSO_DATABASE_URL = "https://cinema-assistant.test";
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
function answer(_system, context) {
  const input = JSON.parse(context);
  return Promise.resolve(JSON.stringify({ answer: "The source explains that inertia resists a change in motion.", citations: [input.sources[0].key] }));
}
test("only standalone explicit mentions invoke Cinema", () => {
  assert.equal(ai.isCinemaAssistantRequest("Hello everyone"), false);
  assert.equal(ai.isCinemaAssistantRequest("person@cinema.example"), false);
  assert.equal(ai.isCinemaAssistantRequest("@Cinema.com"), false);
  assert.equal(ai.isCinemaAssistantRequest("@Cinematographer"), false);
  assert.equal(ai.isCinemaAssistantRequest("@Cinema explain inertia"), true);
  assert.equal(ai.isCinemaAssistantRequest("Please @cinema: explain this"), true);
});
test("requests require membership, ownership, a real question and host consent", async () => {
  const f = await fixture(false), question = await f.write("@Cinema explain inertia");
  const job = await f.request(question); assert.equal(job.status, "FAILED"); assert.match(job.error, /host/);
  await assert.rejects(ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.guest.id, messageId: question.id, configured: true }), error => error.status === 404);
  await assert.rejects(ai.listCinemaAssistantJobs(f.room.id, "outsider"), error => error.status === 403);
  const ordinary = await f.write("Normal conversation"); await assert.rejects(f.request(ordinary), error => error.status === 404);
  const empty = await f.write("@Cinema"); await assert.rejects(f.request(empty), error => error.status === 400);
});
test("a configured and consented request is queued once and returns an evidence-linked reply", async () => {
  const f = await fixture(), source = await f.write("Inertia resists a change in motion."), question = await f.write("@Cinema explain inertia", { parentMessageId: source.id });
  assert.equal((await f.request(question)).status, "QUEUED"); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: answer, roomId: f.room.id });
  assert.equal(reply.assistant.jobId, question.id); assert.equal(reply.senderName, "Cinema"); assert.equal(reply.parentMessageId, question.id);
  assert.equal(reply.threadId, source.id); assert.equal(reply.assistant.citations[0].id, source.id);
  const evidence = await ai.readCinemaAssistantSource({ roomId: f.room.id, studentId: f.guest.id, jobId: question.id, key: reply.assistant.citations[0].key });
  assert.equal(evidence.text, source.content);
  assert.equal((await f.jobs())[0].status, "DONE");
  assert.equal(await ai.processCinemaAssistantJob(question.id, { generate: () => { throw new Error("duplicate call"); } }), null);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_messages WHERE id=?").get(reply.id).n, 1);
});
test("transcript evidence is tied to the requested video, not another playlist entry or an unbound legacy caption", async () => {
  const f = await fixture();
  const old = await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "WRONG VIDEO: pressure is force per area.", atSeconds: 12 });
  sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id);
  const correct = await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists a change in motion.", atSeconds: 12 });
  sql.db.prepare("INSERT INTO cinema_transcript_segments(id,session_id,text,source,created_at,expires_at) VALUES ('legacy-'||?,?,'UNBOUND LEGACY','CALL',?,'')").run(f.room.id, f.room.id, new Date().toISOString());
  const question = await f.write("@Cinema explain inertia", { video: { sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" } }); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: async (_system, context) => {
    assert.equal(context.includes("WRONG VIDEO"), false); assert.equal(context.includes("UNBOUND LEGACY"), false);
    const source = JSON.parse(context).sources.find(source => source.text.includes("Inertia"));
    return JSON.stringify({ answer: "Inertia resists a change in motion.", citations: [source.key] });
  } });
  assert.equal(reply.assistant.citations[0].id, correct.id); assert.notEqual(reply.assistant.citations[0].id, old.id);
});
test("insufficient evidence produces a clear response without invoking a model", async () => {
  const f = await fixture(), question = await f.write("@Cinema explain this"); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: () => { throw new Error("must not run"); } });
  assert.match(reply.content, /enough evidence/); assert.deepEqual(reply.assistant.citations, []);
});
test("unknown citations fail safely and an explicit retry produces one answer", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const question = await f.write("@Cinema explain inertia"); await f.request(question);
  assert.equal(await ai.processCinemaAssistantJob(question.id, { generate: async () => JSON.stringify({ answer: "Invented reference", citations: ["T999"] }) }), null);
  assert.equal((await f.jobs())[0].status, "FAILED");
  await ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: question.id, retry: true, configured: true });
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: answer }); assert.ok(reply.assistant);
  assert.equal((await f.jobs())[0].attempts, 2);
});
test("cancellation during generation prevents publication", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const question = await f.write("@Cinema explain inertia"); await f.request(question);
  const result = await ai.processCinemaAssistantJob(question.id, { generate: async (system, context) => {
    await ai.cancelCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: question.id }); return answer(system, context);
  } });
  assert.equal(result, null); assert.equal((await f.jobs())[0].status, "CANCELLED");
  assert.equal(await messages.readCinemaMessage(`ai-${question.id}`), null);
});
test("revoked consent and removed source messages are rechecked after generation", async () => {
  for (const change of ["consent", "source"]) {
    const f = await fixture(), source = await f.write("Inertia resists motion changes."), question = await f.write("@Cinema explain inertia"); await f.request(question);
    const result = await ai.processCinemaAssistantJob(question.id, { generate: async (system, context) => {
      if (change === "source") await messages.removeCinemaMessage(source.id, f.room.id);
      else await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: true, aiStudyEnabled: false });
      return answer(system, context);
    } });
    assert.equal(result, null); assert.equal((await f.jobs())[0].status, "CANCELLED");
  }
});
test("deleting evidence removes derived answer text and source access", async () => {
  const f = await fixture(), source = await f.write("Inertia resists motion changes."), question = await f.write("@Cinema explain inertia"); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: answer });
  await messages.removeCinemaMessage(source.id, f.room.id);
  assert.equal((await messages.readCinemaMessage(reply.id)).removed, true);
  await assert.rejects(ai.readCinemaAssistantSource({ roomId: f.room.id, studentId: f.host.id, jobId: question.id, key: reply.assistant.citations[0].key }), error => error.status === 404);
});
test("clearing transcripts invalidates transcript-derived replies", async () => {
  const f = await fixture();
  await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 });
  const question = await f.write("@Cinema explain inertia"); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: answer });
  assert.equal(reply.assistant.citations[0].kind, "TRANSCRIPT");
  await transcripts.clearCinemaTranscript(f.room.id, f.host.id);
  assert.equal((await messages.readCinemaMessage(reply.id)).removed, true); assert.equal((await f.jobs())[0].status, "CANCELLED");
});
test("hourly budgets, active-request limits and retry limits are enforced", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes.");
  const first = await f.write("@Cinema one"), second = await f.write("@Cinema two"); await f.request(first);
  await assert.rejects(f.request(second), error => error.status === 429);
  for (let i = 0; i < 3; i++) {
    await ai.processCinemaAssistantJob(first.id, { generate: async () => "malformed" });
    if (i < 2) await ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: first.id, retry: true, configured: true });
  }
  await assert.rejects(ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: first.id, retry: true, configured: true }), error => error.status === 409);
});
test("retention purges questions, assistant content, jobs and evidence together", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const question = await f.write("@Cinema explain inertia"); await f.request(question);
  await ai.processCinemaAssistantJob(question.id, { generate: answer }); await messages.purgeCinemaMessages(f.room.id);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_chat_ai_jobs WHERE session_id=?").get(f.room.id).n, 0);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_chat_ai_evidence WHERE job_id=?").get(question.id).n, 0);
});
test("a replacement worker fences an expired claim without publishing twice", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes."); const question = await f.write("@Cinema explain inertia"); await f.request(question);
  let second;
  const first = await ai.processCinemaAssistantJob(question.id, { generate: async (system, context) => {
    sql.db.prepare("UPDATE cinema_chat_ai_jobs SET lease_until='2000-01-01' WHERE id=?").run(question.id);
    second = await ai.processCinemaAssistantJob(question.id, { generate: answer });
    return answer(system, context);
  } });
  assert.equal(first, null); assert.ok(second.assistant);
  const job = (await f.jobs())[0]; assert.equal(job.status, "DONE"); assert.equal(job.attempts, 2);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_messages WHERE id=?").get(second.id).n, 1);
});
test("only the requester or a host can cancel, and source IDs cannot cross rooms", async () => {
  const f = await fixture(), other = await fixture(); await f.write("Inertia resists motion changes.");
  const question = await f.write("@Cinema explain inertia"); await f.request(question);
  await assert.rejects(ai.cancelCinemaAssistant({ roomId: f.room.id, studentId: f.guest.id, messageId: question.id }), error => error.status === 403);
  assert.equal(await ai.processCinemaAssistantJob(question.id, { roomId: other.room.id, generate: answer }), null);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: answer });
  await assert.rejects(ai.readCinemaAssistantSource({ roomId: other.room.id, studentId: other.host.id, jobId: question.id, key: reply.assistant.citations[0].key }), error => error.status === 404);
  const guestQuestion = await messages.writeCinemaMessage({ sessionId: f.room.id, sender: f.guest, content: "@Cinema explain this", video: f.video });
  await ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.guest.id, messageId: guestQuestion.id, configured: true });
  assert.equal((await ai.cancelCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: guestQuestion.id })).status, "CANCELLED");
});
test("loss of requester membership and transcript consent both prevent publication", async () => {
  for (const change of ["membership", "transcript"]) {
    const f = await fixture(); await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 });
    const question = await messages.writeCinemaMessage({ sessionId: f.room.id, sender: f.guest, content: "@Cinema explain inertia", video: f.video });
    await ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.guest.id, messageId: question.id, configured: true });
    const result = await ai.processCinemaAssistantJob(question.id, { generate: async (system, context) => {
      if (change === "membership") sql.db.prepare("DELETE FROM cinema_participants WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id);
      else await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: false, aiStudyEnabled: true });
      return answer(system, context);
    } });
    assert.equal(result, null); assert.equal((await f.jobs())[0].status, "CANCELLED");
  }
});
test("expired transcript passages are excluded and provider configuration is required", async () => {
  const f = await fixture(); const segment = await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 });
  sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(segment.id);
  const question = await f.write("@Cinema explain inertia"); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: () => { throw new Error("expired evidence must not be sent"); } });
  assert.match(reply.content, /enough evidence/);
  const unconfigured = await f.write("@Cinema another question");
  const job = await ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: unconfigured.id, configured: false });
  assert.equal(job.status, "FAILED"); assert.match(job.error, /not configured/); assert.equal(job.attempts, 0);
});
test("new-question budgets apply per requester and room within the hour", async () => {
  for (const scope of ["user", "room"]) {
    const f = await fixture(), question = await f.write("@Cinema explain inertia"), stamp = new Date().toISOString();
    const seed = sql.db.prepare("INSERT INTO cinema_chat_ai_jobs(id,session_id,requested_by,status,created_at,updated_at) VALUES (?,?,?,'FAILED',?,?)");
    for (let i = 0; i < (scope === "user" ? 6 : 30); i++) seed.run(`budget-${f.room.id}-${i}`, scope === "room" ? f.room.id : `other-${i}`, scope === "user" ? f.host.id : `other-${i}`, stamp, stamp);
    await assert.rejects(f.request(question), error => error.status === 429);
  }
});
test("WebVTT imports attach the selected video without doubling the imported count", async () => {
  const f = await fixture();
  const result = await transcripts.importCinemaVtt({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", content: "WEBVTT\n\n00:00:12.000 --> 00:00:15.000\nInertia resists motion changes.\n\n00:00:16.000 --> 00:00:19.000\nA net force changes velocity." });
  assert.equal(result.imported, 2);
  const context = sql.db.prepare("SELECT * FROM cinema_transcript_video_context WHERE session_id=?").all(f.room.id);
  assert.equal(context.length, 2); assert.ok(context.every(row => row.video_id === f.video.videoId && row.source_type === "YOUTUBE"));
});
test("reply evidence remains available beyond the recent 100-message room window", async () => {
  const f = await fixture(), source = await f.write("Inertia resists a change in motion.");
  for (let i = 0; i < 105; i++) await f.write(`Unrelated conversation ${i}`);
  const question = await f.write("@Cinema explain inertia", { parentMessageId: source.id }); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: async (system, context) => {
    const input = JSON.parse(context); assert.equal(input.sources[0].text, source.content); return answer(system, context);
  } });
  assert.equal(reply.assistant.citations[0].id, source.id);
});
test("caption requests with a stale selected video cannot be attached to the next entry", async () => {
  const f = await fixture();
  const expectedVideo = { sourceType: "YOUTUBE", videoId: "another-video" };
  await assert.rejects(transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "A caption", atSeconds: 12, expectedVideo }), error => error.status === 409);
  await assert.rejects(transcripts.importCinemaVtt({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", content: "WEBVTT\n\n00:00:12.000 --> 00:00:15.000\nA caption", expectedVideo }), error => error.status === 409);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_transcript_segments WHERE session_id=?").get(f.room.id).n, 0);
});
test("scheduled retention removes transcript-derived answer content along with expired evidence", async () => {
  const f = await fixture();
  const segment = await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "Inertia resists motion changes.", atSeconds: 12 });
  const question = await f.write("@Cinema explain inertia"); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: answer });
  sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(segment.id);
  const { runCinemaCleanup } = await vite.ssrLoadModule("/lib/cinema-engine/cleanup.ts");
  const result = await runCinemaCleanup({ presence: async () => ({ roomId: f.room.id, memberCount: 1, emptySince: 0 }) });
  assert.equal(result.configured, true);
  assert.equal((await messages.readCinemaMessage(reply.id)).removed, true);
  assert.equal((await f.jobs())[0].status, "CANCELLED");
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_transcript_video_context WHERE segment_id=?").get(segment.id).n, 0);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_transcript_segments WHERE id=?").get(segment.id).n, 0);
});
