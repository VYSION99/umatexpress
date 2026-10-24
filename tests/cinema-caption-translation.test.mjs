import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://cinema-caption-translation.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "cinema-caption-translation-secret-32-chars";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const transcripts = await vite.ssrLoadModule("/lib/cinema-engine/transcripts.ts");

test("caption translation respects membership, consent, room ownership, caching and clearing", async () => {
  const host = { id: "caption-host", name: "Ama", email: "ama@st.umat.edu.gh" };
  const guest = { id: "caption-guest", name: "Kojo", email: "kojo@st.umat.edu.gh" };
  const room = await rooms.createRoom({ student: host, title: "Study", video: "dQw4w9WgXcQ" });
  const request = (studentId, segmentId, language = "fr") => transcripts.translateCinemaCaption({ id: room.id, studentId, segmentId, language });
  await assert.rejects(request(host.id, "missing"), error => error.status === 409);
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: false });
  const segment = await transcripts.addCinemaTranscriptSegment({ id: room.id, studentId: host.id, speakerName: "Ama", text: "Welcome to the lesson.", atSeconds: 8 });
  await assert.rejects(request(host.id, segment.id), error => error.status === 409);
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: false, translationEnabled: true });
  await assert.rejects(request(guest.id, segment.id), error => error.status === 403);
  await rooms.joinRoom({ id: room.id, student: guest });
  await assert.rejects(request(guest.id, segment.id, "unknown"), error => error.status === 400);
  await assert.rejects(request(guest.id, "missing"), error => error.status === 404);
  let startTranslation; let finishTranslation;
  const started = new Promise(resolve => { startTranslation = resolve; });
  const released = new Promise(resolve => { finishTranslation = resolve; });
  let modelCalls = 0;
  const translate = async () => { modelCalls += 1; startTranslation(); await released; return "Bienvenue à la leçon."; };
  const first = transcripts.translateCinemaCaption({ id: room.id, studentId: guest.id, segmentId: segment.id, language: "fr", translate });
  await started;
  await assert.rejects(transcripts.translateCinemaCaption({ id: room.id, studentId: host.id, segmentId: segment.id, language: "fr", translate }), error => error.status === 409);
  finishTranslation();
  assert.deepEqual(await first, { text: "Bienvenue à la leçon.", language: "fr" });
  assert.equal(modelCalls, 1);
  assert.deepEqual(await request(guest.id, segment.id), { text: "Bienvenue à la leçon.", language: "fr" });
  await transcripts.clearCinemaTranscript(room.id, host.id);
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS total FROM cinema_caption_translations WHERE session_id=?").get(room.id).total, 0);
  await assert.rejects(request(guest.id, segment.id), error => error.status === 404);
});

test("host deletion removes captions and cached translations alongside room membership", async () => {
  const host = { id: "deleting-host", name: "Host", email: "host@st.umat.edu.gh" };
  const room = await rooms.createRoom({ student: host, title: "Delete me", video: "dQw4w9WgXcQ" });
  await transcripts.updateCinemaTranscriptPrivacy({ id: room.id, studentId: host.id, transcriptEnabled: true, aiStudyEnabled: false, translationEnabled: true });
  const segment = await transcripts.addCinemaTranscriptSegment({ id: room.id, studentId: host.id, speakerName: "Host", text: "Good morning.", atSeconds: 2 });
  await transcripts.translateCinemaCaption({ id: room.id, studentId: host.id, segmentId: segment.id, language: "fr", translate: async () => "Bonjour." });
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS total FROM cinema_caption_translations WHERE session_id=?").get(room.id).total, 1);
  assert.deepEqual(await rooms.deleteRoom({ id: room.id, studentId: host.id }), { deleted: true });
  for (const table of ["cinema_caption_translations", "cinema_transcript_segments", "cinema_participants"]) {
    assert.equal(sql.db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE session_id=?`).get(room.id).total, 0);
  }
});
