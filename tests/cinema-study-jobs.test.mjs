import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";
import { readFile } from "node:fs/promises";

process.env.TURSO_DATABASE_URL = "https://cinema-study-jobs.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "cinema-study-test-session-secret-32-characters";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
let beforePublication, beforeInvalidation, beforeValidatedRead;
globalThis.fetch = async (...args) => {
  const statements = JSON.parse(args[1].body).requests.flatMap(request => request.type === "execute" ? [request.stmt.sql] : (request.batch?.steps || []).map(step => step.stmt.sql));
  if (beforePublication && statements.some(statement => statement.startsWith("INSERT INTO cinema_study_packs"))) {
    const hook = beforePublication; beforePublication = null; await hook();
  }
  if (beforeInvalidation && statements.some(statement => statement.startsWith("DELETE FROM cinema_study_packs WHERE id=?"))) {
    const hook = beforeInvalidation; beforeInvalidation = null; await hook();
  }
  if (beforeValidatedRead && statements.some(statement => statement.startsWith("SELECT pack.id FROM cinema_study_packs"))) {
    const hook = beforeValidatedRead; beforeValidatedRead = null; await hook();
  }
  return sql.fetch(...args);
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const transcripts = await vite.ssrLoadModule("/lib/cinema-engine/transcripts.ts");
const study = await vite.ssrLoadModule("/lib/cinema-engine/study.ts");

test("study requests need consent and source material, then deduplicate queued work", async () => {
  const host = { id: "study-host", name: "Ama", email: "ama@st.umat.edu.gh" };
  const guest = { id: "study-guest", name: "Kojo", email: "kojo@st.umat.edu.gh" };
  const room = await rooms.createRoom({ student: host, title: "Physics revision", video: "dQw4w9WgXcQ" });
  await assert.rejects(study.requestCinemaStudyPack({ id: room.id, studentId: host.id }), (error) => error.status === 409);
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: true });
  await assert.rejects(study.requestCinemaStudyPack({ id: room.id, studentId: host.id }), (error) => error.status === 409);
  await transcripts.addCinemaTranscriptSegment({ id: room.id, studentId: host.id, speakerName: "Ama", text: "The experiment measures gravitational acceleration.", atSeconds: 12 });
  await rooms.joinRoom({ id: room.id, student: guest });
  await assert.rejects(study.requestCinemaStudyPack({ id: room.id, studentId: guest.id }), (error) => error.status === 403);
  assert.equal((await study.requestCinemaStudyPack({ id: room.id, studentId: host.id })).status, "QUEUED");
  await study.requestCinemaStudyPack({ id: room.id, studentId: host.id });
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_jobs WHERE session_id=?").get(room.id).n, 1);
  await study.generatePendingCinemaStudyPack({ generate: async () => { throw new Error("AI unavailable"); } });
  assert.equal((await study.readCinemaStudyJob(room.id, host.id)).status, "FAILED");
  await study.requestCinemaStudyPack({ id: room.id, studentId: host.id });
  assert.equal((await study.readCinemaStudyJob(room.id, host.id)).status, "QUEUED");
  await study.generatePendingCinemaStudyPack({ generate: async () => ({ id: "test-pack" }) });
  assert.equal((await study.readCinemaStudyJob(room.id, host.id)).status, "DONE");
});

let serial = 0;
async function fixture() {
  const host = { id: `pack-host-${++serial}`, name: "Ama" }, guest = { id: `pack-guest-${serial}`, name: "Kojo" };
  const room = await rooms.createRoom({ student: host, title: "Study publication", video: "dQw4w9WgXcQ" });
  await rooms.joinRoom({ id: room.id, student: guest });
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: true });
  const segment = await transcripts.addCinemaTranscriptSegment({ id: room.id, studentId: host.id, speakerName: "Ama", text: "Sensitive source: inertia resists changes in motion.", atSeconds: 12 });
  return { host, guest, room, segment };
}
const output = () => JSON.stringify({ summary: "Inertia resists changes in motion.", chapters: [], notes: [{ text: "Review inertia." }], flashcards: [], questions: [] });

test("shared study packs publish valid evidence and hide after AI consent is revoked", async () => {
  const f = await fixture();
  const pack = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  assert.match(pack.summary, /Inertia/);
  assert.equal((await study.readCinemaStudyPack(f.room.id, f.guest.id)).id, pack.id);
  await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: true, aiStudyEnabled: false });
  assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null);
});

test("consent revocation and transcript clearing during generation prevent publication", async () => {
  const f = await fixture();
  await assert.rejects(study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => {
    await transcripts.updateCinemaTranscriptPrivacy({ id: f.room.id, studentId: f.host.id, transcriptEnabled: false, aiStudyEnabled: false });
    await transcripts.clearCinemaTranscript(f.room.id, f.host.id);
    return output();
  } }), error => error.status === 409);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_packs WHERE session_id=?").get(f.room.id).n, 0);
});

test("publication atomically fences consent, roles, membership, expired sources and source edits", async () => {
  for (const change of ["consent", "transcript-consent", "role", "membership", "expiry", "text", "clear", "expired-room"]) {
    const f = await fixture();
    await rooms.setRoomMemberRole({ id: f.room.id, studentId: f.host.id, guestId: f.guest.id, role: "COHOST" });
    beforePublication = async () => {
      if (change === "consent") sql.db.prepare("UPDATE cinema_session_privacy SET ai_study_enabled=0 WHERE session_id=?").run(f.room.id);
      if (change === "transcript-consent") sql.db.prepare("UPDATE cinema_session_privacy SET transcript_enabled=0 WHERE session_id=?").run(f.room.id);
      if (change === "role") sql.db.prepare("UPDATE cinema_participants SET role='VIEWER' WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id);
      if (change === "membership") sql.db.prepare("DELETE FROM cinema_participants WHERE session_id=? AND student_id=?").run(f.room.id, f.guest.id);
      if (change === "expiry") sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(f.segment.id);
      if (change === "text") sql.db.prepare("UPDATE cinema_transcript_segments SET text='Changed source' WHERE id=?").run(f.segment.id);
      if (change === "clear") await transcripts.clearCinemaTranscript(f.room.id, f.host.id);
      if (change === "expired-room") sql.db.prepare("UPDATE cinema_sessions SET status='EXPIRED' WHERE id=?").run(f.room.id);
    };
    await assert.rejects(study.generateCinemaStudyPack({ id: f.room.id, studentId: f.guest.id, generate: async () => output() }), error => error.status === 409);
    assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_packs WHERE session_id=?").get(f.room.id).n, 0, change);
  }
});

test("removing bookmark evidence at publication prevents a bookmark-only pack", async () => {
  const f = await fixture();
  await transcripts.clearCinemaTranscript(f.room.id, f.host.id);
  const bookmark = await rooms.addCinemaBookmark({ id: f.room.id, studentId: f.host.id, label: "Discuss inertia", atSeconds: 12 });
  beforePublication = () => rooms.deleteCinemaBookmark({ id: f.room.id, studentId: f.host.id, bookmarkId: bookmark.id });
  await assert.rejects(study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() }), error => error.status === 409);
});

test("clearing a transcript deletes a previously generated shared pack", async () => {
  const f = await fixture();
  await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  await transcripts.clearCinemaTranscript(f.room.id, f.host.id);
  assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null);
});

test("published packs invalidate changed, expired, deleted and unverifiable evidence", async () => {
  for (const change of ["expiry", "delete", "text", "video", "legacy"]) {
    const f = await fixture();
    const pack = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
    assert.ok(pack.expiresAt);
    const evidence = sql.db.prepare("SELECT * FROM cinema_study_pack_evidence WHERE pack_id=?").all(pack.id);
    assert.equal(evidence.length, 1);
    assert.match(evidence[0].digest, /^[a-f0-9]{64}$/);
    assert.equal("text" in evidence[0], false, "evidence does not retain another transcript copy");
    if (change === "expiry") sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(f.segment.id);
    if (change === "delete") sql.db.prepare("DELETE FROM cinema_transcript_segments WHERE id=?").run(f.segment.id);
    if (change === "text") sql.db.prepare("UPDATE cinema_transcript_segments SET text='Changed' WHERE id=?").run(f.segment.id);
    if (change === "video") sql.db.prepare("UPDATE cinema_transcript_video_context SET video_id='M7lc1UVf-VE' WHERE segment_id=?").run(f.segment.id);
    if (change === "legacy") sql.db.prepare("DELETE FROM cinema_study_pack_evidence WHERE pack_id=?").run(pack.id);
    assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null, change);
    assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_packs WHERE id=?").get(pack.id).n, 0, change);
    assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_pack_evidence WHERE pack_id=?").get(pack.id).n, 0, change);
  }
});

test("bookmark deletion removes the derived pack in the deletion transaction", async () => {
  const f = await fixture();
  const bookmark = await rooms.addCinemaBookmark({ id: f.room.id, studentId: f.host.id, label: "Discuss inertia", atSeconds: 12 });
  const pack = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  await rooms.deleteCinemaBookmark({ id: f.room.id, studentId: f.host.id, bookmarkId: bookmark.id });
  assert.equal(sql.db.prepare("SELECT id FROM cinema_study_packs WHERE id=?").get(pack.id), undefined);
  assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_pack_evidence WHERE pack_id=?").get(pack.id).n, 0);
});

test("expiry cleanup removes derived packs before physically deleting transcripts", async () => {
  const auth = await vite.ssrLoadModule("/lib/student-auth.ts"); await auth.ensureStudentAccountsTable();
  const cleanup = await vite.ssrLoadModule("/lib/cinema-engine/cleanup.ts");
  const f = await fixture();
  const pack = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  sql.db.prepare("UPDATE cinema_transcript_segments SET expires_at='2000-01-01' WHERE id=?").run(f.segment.id);
  await cleanup.runCinemaCleanup({ presence: async () => ({ members: [], connectedCount: 1, emptySince: 0 }) });
  assert.equal(sql.db.prepare("SELECT id FROM cinema_transcript_segments WHERE id=?").get(f.segment.id), undefined);
  assert.equal(sql.db.prepare("SELECT id FROM cinema_study_packs WHERE id=?").get(pack.id), undefined);
  assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null);
});

test("chapter timestamps and videos come from cited sources, surviving video changes safely", async () => {
  const f = await fixture();
  const pack = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async (_system, context) => {
    const source = JSON.parse(context).sources[0];
    return JSON.stringify({ ...JSON.parse(output()), chapters: [{ title: "Inertia", sourceKey: source.key, atSeconds: 999, video: { sourceType: "UPLOAD", videoId: "invented" }, summary: "Review inertia." }] });
  } });
  assert.equal(pack.chapters[0].atSeconds, 12);
  assert.deepEqual(pack.chapters[0].video, { sourceType: "YOUTUBE", videoId: f.room.videoId });
  sql.db.prepare("UPDATE cinema_sessions SET video_id='M7lc1UVf-VE' WHERE id=?").run(f.room.id);
  assert.deepEqual((await study.readCinemaStudyPack(f.room.id, f.guest.id)).chapters[0].video, pack.chapters[0].video);
  await assert.rejects(study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => JSON.stringify({ summary: "Invalid", chapters: [{ title: "Invented", sourceKey: "UNKNOWN" }] }) }), error => error.status === 502);
  assert.equal((await study.readCinemaStudyPack(f.room.id, f.guest.id)).id, pack.id, "invalid generation preserves the valid version");
});

test("regeneration atomically replaces the pack version and its dependency set", async () => {
  const f = await fixture();
  const first = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  const next = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  assert.notEqual(next.id, first.id);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_pack_evidence WHERE pack_id=?").get(first.id).n, 0);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_pack_evidence WHERE pack_id=?").get(next.id).n, 1);
});

test("an invalidating reader cannot delete a concurrently regenerated version", async () => {
  const f = await fixture();
  const first = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  sql.db.prepare("UPDATE cinema_transcript_segments SET text='New source' WHERE id=?").run(f.segment.id);
  let replacement;
  beforeInvalidation = async () => { replacement = await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() }); };
  assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null);
  assert.notEqual(replacement.id, first.id);
  assert.equal((await study.readCinemaStudyPack(f.room.id, f.guest.id)).id, replacement.id);
});

test("source changes between dependency validation and response cannot leak stale text", async () => {
  const f = await fixture();
  await study.generateCinemaStudyPack({ id: f.room.id, studentId: f.host.id, generate: async () => output() });
  beforeValidatedRead = () => sql.db.prepare("DELETE FROM cinema_transcript_segments WHERE id=?").run(f.segment.id);
  assert.equal(await study.readCinemaStudyPack(f.room.id, f.guest.id), null);
});

test("overlapping automatic workers share one queued job and one claim", async () => {
  const f = await fixture();
  sql.db.prepare("UPDATE cinema_sessions SET status='ENDED',ended_at=? WHERE id=?").run(new Date().toISOString(), f.room.id);
  let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const generate = async input => { calls++; started(); await gate; return study.generateCinemaStudyPack({ ...input, generate: async () => output() }); };
  const first = study.generatePendingCinemaStudyPack({ generate });
  try {
    await entered;
    assert.deepEqual(await study.generatePendingCinemaStudyPack({ generate }), { generated: 0 });
    assert.equal(calls, 1);
    const claim = sql.db.prepare("SELECT * FROM cinema_study_job_claims WHERE session_id=?").get(f.room.id);
    await study.requestCinemaStudyPack({ id: f.room.id, studentId: f.host.id });
    assert.deepEqual(sql.db.prepare("SELECT * FROM cinema_study_job_claims WHERE session_id=?").get(f.room.id), claim, "duplicate request cannot reset a running lease");
  } finally { release(); }
  assert.deepEqual(await first, { generated: 1 });
  assert.equal((await study.readCinemaStudyJob(f.room.id, f.host.id)).status, "DONE");
});

test("a replaced lease fences both stale publication and stale job completion", async () => {
  const f = await fixture(); await study.requestCinemaStudyPack({ id: f.room.id, studentId: f.host.id });
  let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const first = study.generatePendingCinemaStudyPack({ generate: input => study.generateCinemaStudyPack({ ...input, generate: async () => { started(); await gate; return output(); } }) });
  await entered;
  const oldToken = sql.db.prepare("SELECT claim_token FROM cinema_study_job_claims WHERE session_id=?").get(f.room.id).claim_token;
  sql.db.prepare("UPDATE cinema_study_job_claims SET lease_until='2000-01-01' WHERE session_id=?").run(f.room.id);
  try {
    assert.deepEqual(await study.generatePendingCinemaStudyPack({ generate: input => study.generateCinemaStudyPack({ ...input, generate: async () => JSON.stringify({ ...JSON.parse(output()), summary: "Replacement worker" }) }) }), { generated: 1 });
  } finally { release(); }
  assert.deepEqual(await first, { generated: 0 });
  assert.notEqual(sql.db.prepare("SELECT claim_token FROM cinema_study_job_claims WHERE session_id=?").get(f.room.id).claim_token, oldToken);
  assert.equal((await study.readCinemaStudyJob(f.room.id, f.host.id)).status, "DONE");
  assert.equal((await study.readCinemaStudyPack(f.room.id, f.guest.id)).summary, "Replacement worker");
});

test("exhausted claims stop automatic retries and manual retry starts a fresh budget", async () => {
  const f = await fixture(); await study.requestCinemaStudyPack({ id: f.room.id, studentId: f.host.id });
  sql.db.prepare("UPDATE cinema_study_jobs SET status='RUNNING' WHERE session_id=?").run(f.room.id);
  sql.db.prepare("UPDATE cinema_study_job_claims SET attempts=3,lease_until='2000-01-01' WHERE session_id=?").run(f.room.id);
  let calls = 0;
  assert.deepEqual(await study.generatePendingCinemaStudyPack({ generate: async () => { calls++; } }), { generated: 0 });
  assert.equal(calls, 0);
  assert.equal((await study.readCinemaStudyJob(f.room.id, f.host.id)).status, "FAILED");
  await study.requestCinemaStudyPack({ id: f.room.id, studentId: f.host.id });
  assert.equal(sql.db.prepare("SELECT attempts FROM cinema_study_job_claims WHERE session_id=?").get(f.room.id).attempts, 0);
  await study.generatePendingCinemaStudyPack({ generate: input => study.generateCinemaStudyPack({ ...input, generate: async () => output() }) });
  assert.equal((await study.readCinemaStudyJob(f.room.id, f.host.id)).status, "DONE");
});

test("study evidence migration is repeatable on existing data", async () => {
  const migration = await readFile(new URL("../sql/056_cinema_study_evidence_claims.sql", import.meta.url), "utf8");
  sql.db.exec(migration); sql.db.exec(migration);
  assert.ok(sql.db.prepare("SELECT COUNT(*) AS n FROM cinema_study_job_claims").get().n);
});
