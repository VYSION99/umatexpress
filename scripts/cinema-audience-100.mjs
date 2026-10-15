import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "../tests/helpers/sqlite-turso.mjs";

// Application-path rehearsal with real Cinema SQL and an in-memory SQLite adapter.
// This is not a deployed HTTP, browser, YouTube, or bandwidth load test.
process.env.TURSO_DATABASE_URL = "https://cinema-audience-rehearsal.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "cinema-audience-rehearsal-secret-at-least-32-chars";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });

function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)].toFixed(1));
}
async function burst(label, items, operation) {
  const start = performance.now();
  const durations = [];
  const results = await Promise.all(items.map(async (item) => {
    const began = performance.now();
    try { return await operation(item); }
    finally { durations.push(performance.now() - began); }
  }));
  return { label, totalMs: Number((performance.now() - start).toFixed(1)), p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), results };
}

try {
  const events = await vite.ssrLoadModule("/lib/cinema-engine/events.ts");
  const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
  const polls = await vite.ssrLoadModule("/lib/cinema-engine/polls.ts");
  const questions = await vite.ssrLoadModule("/lib/cinema-engine/questions.ts");
  const stage = await vite.ssrLoadModule("/lib/cinema-engine/stage-requests.ts");
  const host = { id: "cinema-host", name: "Host", email: "host@st.umat.edu.gh" };
  const audience = Array.from({ length: 120 }, (_, index) => ({ id: `audience-${index + 1}`, name: `Viewer ${index + 1}`, email: `viewer${index + 1}@example.com` }));
  const [event] = await events.createCinemaEvents({
    student: host, organizerName: "Cinema rehearsal", organizerType: "STUDENT_GROUP",
    title: "100-person panel rehearsal", format: "PANEL", stageLimit: 4, capacity: 100,
    video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    startsAt: new Date(Date.now() + 30 * 60_000).toISOString(), durationMinutes: 60,
  });
  const admissions = await burst("120 simultaneous RSVP requests", audience, (person) => events.setCinemaEventRsvp({ id: event.id, student: person, going: true }));
  const admitted = admissions.results.filter((result) => result.viewerRsvp === "GOING");
  const waitlisted = admissions.results.filter((result) => result.viewerRsvp === "WAITLIST");
  assert.equal(admitted.length, 100, "exactly 100 viewers must be admitted");
  assert.equal(waitlisted.length, 20, "the rest must wait");
  const confirmedPeople = audience.filter((_, index) => admissions.results[index].viewerRsvp === "GOING");
  const waitingPerson = audience.find((_, index) => admissions.results[index].viewerRsvp === "WAITLIST");
  assert.ok(waitingPerson);
  assert.equal((await rooms.readRoom({ id: event.sessionId, studentId: waitingPerson.id })).videoId, "", "waitlisted accounts must not receive the broadcast ID");
  await assert.rejects(rooms.joinRoom({ id: event.sessionId, student: waitingPerson }), (error) => error.status === 403);

  const joins = await burst("100 audience room entries", confirmedPeople, (person) => rooms.joinRoom({ id: event.sessionId, student: person }));
  assert.equal(joins.results.length, 100);
  const poll = await polls.createCinemaPoll({ id: event.sessionId, studentId: host.id, question: "Which topic should the panel cover next?", options: ["Housing", "Transport", "Campus life"], kind: "POLL", correctIndex: -1 });
  const votes = await burst("100 simultaneous poll votes", confirmedPeople, (person) => polls.voteCinemaPoll({ id: event.sessionId, studentId: person.id, pollId: poll.id, optionIndex: 0 }));
  assert.equal(votes.results.length, 100);
  const readPolls = await burst("100 audience poll refreshes", confirmedPeople, (person) => polls.listCinemaPolls(event.sessionId, person.id));
  assert.equal(readPolls.results[0][0].votes.reduce((total, count) => total + count, 0), 100);
  const asked = await burst("30 simultaneous audience questions", confirmedPeople.slice(0, 30), (person) => questions.submitDiscussionQuestion({ id: event.sessionId, studentId: person.id, displayName: person.name, text: `Question from ${person.name}: how will the panel respond?` }));
  assert.equal(asked.results.length, 30);
  const questionReads = await burst("100 audience question refreshes", confirmedPeople, (person) => questions.listDiscussionQuestions(event.sessionId, person.id));
  assert.equal(questionReads.results.length, 100);

  const panelists = confirmedPeople.slice(0, 3);
  for (const person of panelists) {
    await stage.requestStage({ id: event.sessionId, studentId: person.id, displayName: person.name });
    await stage.decideStageRequest({ id: event.sessionId, studentId: host.id, guestId: person.id, action: "APPROVE" });
    assert.equal((await stage.discussionAudienceState(event.sessionId, person.id)).role, "PRESENTER");
  }
  await stage.requestStage({ id: event.sessionId, studentId: confirmedPeople[3].id, displayName: confirmedPeople[3].name });
  await assert.rejects(stage.decideStageRequest({ id: event.sessionId, studentId: host.id, guestId: confirmedPeople[3].id, action: "APPROVE" }), (error) => error.status === 409);
  console.log(JSON.stringify({ result: "PASS", audienceCap: 100, admitted: admitted.length, waitlisted: waitlisted.length, panelists: 3, operations: [admissions, joins, votes, readPolls, asked, questionReads].map(({ results, ...timing }) => timing) }, null, 2));
} finally {
  await vite.close();
  sql.db.close();
  globalThis.fetch = originalFetch;
}
