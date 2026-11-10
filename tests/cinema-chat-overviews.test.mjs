import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";
process.env.TURSO_DATABASE_URL = "https://cinema-overviews.test";
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
const commands = await vite.ssrLoadModule("/lib/cinema-engine/chat-assistant-text.ts");
let serial = 0;
async function fixture(enabled = true) {
  const host = { id: `host-${++serial}`, name: "Ama" }, guest = { id: `guest-${serial}`, name: "Kojo" };
  const room = await rooms.createRoom({ student: host, video: "dQw4w9WgXcQ", title: "Mechanics" });
  await rooms.joinRoom({ id: room.id, student: guest });
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: enabled });
  const video = { sourceType: "YOUTUBE", videoId: room.videoId };
  const write = (content, extra = {}) => messages.writeCinemaMessage({ sessionId: room.id, sender: host, content, video, atSeconds: 12, ...extra });
  return { room, host, guest, video, write,
    request: (message, configured = true) => ai.requestCinemaAssistant({ roomId: room.id, studentId: host.id, messageId: message.id, configured }),
    jobs: async () => (await ai.listCinemaAssistantJobs(room.id, host.id)).jobs,
  };
}
const requestText = mode => commands.CINEMA_OVERVIEW_REQUESTS[mode];
const summarize = async (_system, context) => {
  const input = JSON.parse(context);
  return JSON.stringify({ items: [{ text: "The room discussed inertia and changes in motion.", citations: [input.sources[0].key] }] });
};
async function ask(f, mode, generate = summarize, extra = {}) {
  const question = await f.write(requestText(mode), extra); await f.request(question);
  const reply = await ai.processCinemaAssistantJob(question.id, { generate });
  return { question, reply };
}

test("overview commands are exact and ordinary questions keep their normal intent", () => {
  for (const mode of ["CATCH_UP", "REPEATED", "UNANSWERED"]) {
    assert.equal(commands.cinemaOverviewMode(requestText(mode)), mode);
    assert.equal(commands.cinemaOverviewMode(`  ${requestText(mode).toUpperCase()}  `), mode);
    assert.equal(commands.isCinemaChatQuestion(requestText(mode)), false);
  }
  assert.equal(commands.cinemaOverviewMode("@Cinema how can I catch up?"), null);
  assert.equal(commands.isCinemaChatQuestion("What is inertia?"), true);
  assert.equal(commands.isCinemaChatQuestion("Explain inertia"), true);
  assert.equal(commands.isCinemaChatQuestion("We discussed inertia today."), false);
});
test("catch-up summaries use same-video chat before the request and ignore transcripts, AI and removals", async () => {
  const f = await fixture(), other = await fixture();
  await other.write("OTHER ROOM SECRET");
  await transcripts.addCinemaTranscriptSegment({ id: f.room.id, studentId: f.host.id, speakerName: "Ama", text: "TRANSCRIPT SECRET", atSeconds: 12 });
  const source = await f.write("Ama described inertia as resistance to motion changes.");
  await f.write("WRONG VIDEO SECRET", { video: { sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" } });
  await f.write("UNBOUND SECRET", { video: undefined });
  const removed = await f.write("REMOVED SECRET"); await messages.removeCinemaMessage(removed.id, f.room.id);
  const generated = await f.write("AI SECRET");
  sql.db.prepare("UPDATE cinema_messages SET metadata=? WHERE id=?").run(JSON.stringify({ assistant: { jobId: "old", citations: [] }, video: f.video }), generated.id);
  const question = await f.write(requestText("CATCH_UP")); await f.request(question);
  await f.write("LATER SECRET");
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: async (system, context) => {
    assert.match(system, /untrusted/); assert.doesNotMatch(context, /SECRET/);
    const input = JSON.parse(context); assert.equal(input.sources.length, 1); assert.equal(input.mode, "CATCH_UP");
    return summarize(system, context);
  } });
  assert.equal(reply.assistant.overview.mode, "CATCH_UP");
  assert.equal(reply.assistant.overview.scope.throughSequence, question.sequence - 1);
  assert.equal(reply.assistant.overview.scope.asOf, question.createdAt);
  assert.equal(reply.assistant.citations[0].id, source.id);
  assert.deepEqual(reply.assistant.dependencies, [source.id]);
  const passage = await ai.readCinemaAssistantSource({ roomId: f.room.id, studentId: f.guest.id, jobId: question.id, key: "M1" });
  assert.equal(passage.text, source.content); assert.equal(passage.threadId, source.id);
});
test("catch-up windows disclose bounded sampling and retain their original upper boundary", async () => {
  const f = await fixture(), written = [];
  for (let i = 0; i < 110; i++) written.push(await f.write(`Topic update ${i}`));
  const { question, reply } = await ask(f, "CATCH_UP", async (system, context) => {
    const input = JSON.parse(context); assert.equal(input.sources.length, 40);
    assert.equal(input.sources[0].text, "Topic update 70"); assert.equal(input.sources.at(-1).text, "Topic update 109");
    assert.equal(input.scope.scannedMessages, 100); assert.equal(input.scope.limited, true);
    return summarize(system, context);
  });
  const scope = reply.assistant.overview.scope;
  assert.equal(scope.fromSequence, written[10].sequence); assert.equal(scope.throughSequence, question.sequence - 1);
  assert.equal(reply.assistant.dependencies.length, 40);
});
test("unlinked summaries can span the room without claiming a single video scope", async () => {
  const f = await fixture(); await f.write("First-video discussion"); await f.write("Second-video discussion", { video: { sourceType: "UPLOAD", videoId: "different-upload" } });
  const { reply } = await ask(f, "CATCH_UP", async (system, context) => {
    assert.equal(JSON.parse(context).sources.length, 2); return summarize(system, context);
  }, { video: undefined });
  assert.equal(reply.assistant.overview.scope.video, undefined);
});
test("repeated-question groups cite only detected questions and derive their counts from membership", async () => {
  const f = await fixture();
  const first = await f.write("What is inertia?"), second = await f.write("How would you define inertia?");
  await f.write("What is the SI unit of force?"); await f.write("A statement about inertia."); await f.write(requestText("CATCH_UP"));
  const { reply } = await ask(f, "REPEATED", async (_system, context) => {
    const input = JSON.parse(context); assert.equal(input.sources.length, 3);
    return JSON.stringify({ items: [{ text: "Meaning of inertia", count: 999, citations: input.sources.slice(0, 2).map(source => source.key) }] });
  });
  assert.equal(reply.assistant.overview.totalItems, 1); assert.equal(reply.assistant.overview.items[0].count, undefined);
  assert.equal(reply.assistant.overview.items[0].citations.length, 2);
  assert.deepEqual(reply.assistant.citations.map(source => source.id), [first.id, second.id]);
});
test("unknown, duplicate and overlapping group memberships fail without publication", async () => {
  for (const memberships of [[["M1"]], [["M1", "M1"]], [["M1", "M999"]], [["M1", "M2"], ["M2", "M3"]]]) {
    const f = await fixture(); await f.write("What is inertia?"); await f.write("How do we define inertia?"); await f.write("Why does inertia matter?");
    const { question, reply } = await ask(f, "REPEATED", async () => JSON.stringify({ items: memberships.map(citations => ({ text: "A group", citations })) }));
    assert.equal(reply, null); assert.equal((await f.jobs())[0].status, "FAILED");
    assert.equal(await messages.readCinemaMessage(`ai-${question.id}`), null);
  }
});
test("malformed or invented summary evidence can be explicitly retried", async () => {
  const f = await fixture(); await f.write("Inertia was discussed.");
  const { question, reply } = await ask(f, "CATCH_UP", async () => JSON.stringify({ items: [{ text: "An invented fact", citations: ["M999"] }] }));
  assert.equal(reply, null);
  await ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.host.id, messageId: question.id, retry: true, configured: true });
  const retried = await ai.processCinemaAssistantJob(question.id, { generate: summarize });
  assert.equal(retried.assistant.overview.mode, "CATCH_UP"); assert.equal((await f.jobs())[0].attempts, 2);
});
test("unanswered digests use direct reply records as of the request and need no provider", async () => {
  const f = await fixture();
  const first = await f.write("What is inertia?"), answered = await f.write("What is force?");
  await f.write("Force changes momentum.", { parentMessageId: answered.id });
  const nested = await f.write("Why does that matter?", { parentMessageId: answered.id });
  await f.write("This is an ordinary statement.");
  const question = await f.write(requestText("UNANSWERED"));
  assert.equal((await f.request(question, false)).status, "QUEUED");
  await f.write("A later reply must not rewrite the snapshot.", { parentMessageId: first.id });
  const reply = await ai.processCinemaAssistantJob(question.id, { generate: () => { throw new Error("digest must not invoke AI"); } });
  assert.equal(reply.assistant.overview.mode, "UNANSWERED"); assert.equal(reply.assistant.overview.totalItems, 2);
  assert.deepEqual(reply.assistant.citations.map(source => source.id), [first.id, nested.id]);
  assert.match(reply.content, /no direct reply recorded/);
});
test("a stored AI reply counts as a direct reply without inferring correctness", async () => {
  const f = await fixture(); await f.write("Inertia resists motion changes.");
  const question = await f.write("@Cinema explain inertia"); await f.request(question);
  await ai.processCinemaAssistantJob(question.id, { generate: async (_system, context) => JSON.stringify({ answer: "The source describes inertia.", citations: [JSON.parse(context).sources[0].key] }) });
  const { reply } = await ask(f, "UNANSWERED", () => { throw new Error("no model"); });
  assert.equal(reply.assistant.overview.totalItems, 0);
});
test("long unanswered digests disclose truncation and show the latest ten detected questions", async () => {
  const f = await fixture(); for (let i = 0; i < 45; i++) await f.write(`How does concept ${i} work?`);
  const { reply } = await ask(f, "UNANSWERED", () => { throw new Error("no model"); });
  const report = reply.assistant.overview;
  assert.equal(report.scope.limited, true); assert.equal(report.totalItems, 40); assert.equal(report.items.length, 10);
  assert.equal(report.items[0].text, "How does concept 35 work?"); assert.match(reply.content, /Showing the latest 10/);
});
test("empty overviews and singleton groups skip model work", async () => {
  for (const mode of ["CATCH_UP", "REPEATED", "UNANSWERED"]) {
    const f = await fixture(); if (mode === "REPEATED") await f.write("What is inertia?");
    const { reply } = await ask(f, mode, () => { throw new Error("no useful inputs"); });
    assert.equal(reply.assistant.overview.items.length, 0); assert.equal((await f.jobs())[0].status, "DONE");
  }
});
test("overviews retain host consent and room membership checks", async () => {
  const f = await fixture(false), question = await f.write(requestText("UNANSWERED"));
  assert.equal((await f.request(question, false)).status, "FAILED");
  await assert.rejects(ai.requestCinemaAssistant({ roomId: f.room.id, studentId: "outsider", messageId: question.id, configured: true }), error => error.status === 403);
  await assert.rejects(ai.requestCinemaAssistant({ roomId: f.room.id, studentId: f.guest.id, messageId: question.id, configured: true }), error => error.status === 404);
});
test("every input is a dependency, including messages not named in model citations", async () => {
  for (const timing of ["during", "after"]) {
    const f = await fixture(), cited = await f.write("Inertia was discussed."), uncited = await f.write("A participant challenged that explanation.");
    const { question, reply } = await ask(f, "CATCH_UP", async (system, context) => {
      if (timing === "during") await messages.removeCinemaMessage(uncited.id, f.room.id);
      return summarize(system, context);
    });
    if (timing === "during") { assert.equal(reply, null); assert.equal((await f.jobs())[0].status, "CANCELLED"); }
    else {
      assert.deepEqual(reply.assistant.citations.map(source => source.id), [cited.id]);
      await messages.removeCinemaMessage(uncited.id, f.room.id);
      assert.equal((await messages.readCinemaMessage(reply.id)).removed, true); assert.equal((await f.jobs())[0].status, "CANCELLED");
      await assert.rejects(ai.readCinemaAssistantSource({ roomId: f.room.id, studentId: f.host.id, jobId: question.id, key: "M1" }), error => error.status === 404);
    }
  }
});
test("changed input content is detected during batched revalidation", async () => {
  const f = await fixture(); const source = await f.write("Inertia was discussed.");
  const { reply } = await ask(f, "CATCH_UP", async (system, context) => {
    sql.db.prepare("UPDATE cinema_messages SET content='Changed after sampling' WHERE id=?").run(source.id);
    return summarize(system, context);
  });
  assert.equal(reply, null); assert.equal((await f.jobs())[0].status, "CANCELLED");
});
test("chat-only overviews remain independent of transcript storage consent", async () => {
  const f = await fixture(); await f.write("Inertia was discussed.");
  const { reply } = await ask(f, "CATCH_UP", async (system, context) => {
    await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, aiStudyEnabled: true, transcriptEnabled: false });
    return summarize(system, context);
  });
  assert.ok(reply.assistant.overview);
});
