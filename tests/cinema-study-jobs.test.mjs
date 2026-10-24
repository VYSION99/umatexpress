import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://cinema-study-jobs.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "cinema-study-test-session-secret-32-characters";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
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
