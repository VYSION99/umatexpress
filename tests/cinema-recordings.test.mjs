import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema recordings: a take belongs to its recorder, the bucket's report is the
 * size, and retention deletes the object before the row.
 *
 * The fake Turso keeps rooms, membership and recording rows and refuses what it
 * was not taught, so a query change fails loudly. The fake bucket keeps real
 * multipart state because the rules under test are about what it ends up
 * holding — and about what happens when it refuses to let go.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-recordings-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const state = { rooms: [], members: [], recordings: [], metrics: new Map(), settings: new Map() };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const affected = (count) => ok({ affected_row_count: count });
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });

const RECORDING_COLUMNS = [
  "id", "session_id", "recorder_id", "r2_object_key", "r2_upload_id", "mime_type", "file_size_bytes",
  "duration_seconds", "status", "expires_at", "deleted_at", "created_at", "updated_at",
];

const normalize = (sql) => sql.replace(/\s+/g, " ").trim();

function handle(sql, args) {
  const query = normalize(sql);
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(query)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(query)) return affected(1);
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(query)) return ok(empty);
  if (/^ALTER TABLE/.test(query)) return ok(empty);
  if (/^SELECT key, value, COALESCE\(updated_by,''\) AS updated_by/.test(query)) {
    const rows = [...state.settings].map(([key, value]) => ({ key, value, updated_by: "", updated_at: "" }));
    return ok(rows.length ? table(["key", "value", "updated_by", "updated_at"], rows) : empty);
  }
  if (/^INSERT INTO metrics_counters/.test(query)) {
    const [name, day, amount] = args;
    const key = `${name}:${day}`;
    state.metrics.set(key, (state.metrics.get(key) || 0) + Number(amount));
    return ok(table(["count"], [{ count: state.metrics.get(key) }]));
  }
  if (/^SELECT id,status FROM cinema_sessions WHERE id = \? AND status <> 'DELETED' LIMIT 1$/.test(query)) {
    const room = state.rooms.find((row) => row.id === args[0]);
    return ok(room ? table(["id", "status"], [room]) : empty);
  }
  if (/^SELECT student_id FROM cinema_participants WHERE session_id = \? AND student_id = \? AND left_at = '' LIMIT 1$/.test(query)) {
    const member = state.members.find((row) => row.session_id === args[0] && row.student_id === args[1]);
    return ok(member ? table(["student_id"], [member]) : empty);
  }
  if (/^INSERT INTO cinema_recordings/.test(query)) {
    const [id, sessionId, recorderId, objectKey, uploadId, mimeType, sizeBytes, durationSeconds, expiresAt, createdAt, updatedAt] = args;
    state.recordings.push({
      id, session_id: sessionId, recorder_id: recorderId, r2_object_key: objectKey, r2_upload_id: uploadId,
      mime_type: mimeType, file_size_bytes: sizeBytes, duration_seconds: durationSeconds, status: "UPLOADING",
      expires_at: expiresAt, deleted_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^SELECT id,session_id,recorder_id,r2_object_key/.test(query)) {
    const found = () => {
      if (/WHERE session_id = \? AND recorder_id = \? AND status <> 'DELETED' ORDER BY created_at DESC LIMIT/.test(query)) {
        return state.recordings.filter((row) => row.session_id === args[0] && row.recorder_id === args[1] && row.status !== "DELETED");
      }
      if (/WHERE id = \? AND recorder_id = \? AND status = 'UPLOADING' LIMIT 1$/.test(query)) {
        return state.recordings.filter((row) => row.id === args[0] && row.recorder_id === args[1] && row.status === "UPLOADING");
      }
      if (/WHERE id = \? AND recorder_id = \? AND status <> 'DELETED' LIMIT 1$/.test(query)) {
        return state.recordings.filter((row) => row.id === args[0] && row.recorder_id === args[1] && row.status !== "DELETED");
      }
      if (/WHERE id = \? AND recorder_id = \? LIMIT 1$/.test(query)) {
        return state.recordings.filter((row) => row.id === args[0] && row.recorder_id === args[1]);
      }
      if (/status IN \('READY','FAILED','DELETING'\).*ORDER BY expires_at ASC LIMIT/.test(query)) {
        return state.recordings
          .filter((row) => ["READY", "FAILED", "DELETING"].includes(row.status) && row.expires_at && row.expires_at <= args[0])
          .sort((left, right) => left.expires_at.localeCompare(right.expires_at));
      }
      if (/WHERE session_id = \? AND status <> 'DELETED' LIMIT 50$/.test(query)) {
        return state.recordings.filter((row) => row.session_id === args[0] && row.status !== "DELETED");
      }
      return [];
    };
    const rows = found();
    return ok(rows.length ? table(RECORDING_COLUMNS, rows) : empty);
  }
  if (/^SELECT r2_upload_id FROM cinema_recordings WHERE id = \? AND recorder_id = \? LIMIT 1$/.test(query)) {
    const row = state.recordings.find((entry) => entry.id === args[0] && entry.recorder_id === args[1]);
    return ok(row ? table(["r2_upload_id"], [row]) : empty);
  }
  if (/^UPDATE cinema_recordings SET status = 'READY', updated_at = \? WHERE id = \? AND status = 'UPLOADING'$/.test(query)) {
    const row = state.recordings.find((entry) => entry.id === args[1] && entry.status === "UPLOADING");
    if (!row) return affected(0);
    Object.assign(row, { status: "READY", updated_at: args[0] });
    return affected(1);
  }
  if (/^UPDATE cinema_recordings SET status = 'FAILED', updated_at = \? WHERE id = \? AND status = 'UPLOADING'$/.test(query)) {
    const row = state.recordings.find((entry) => entry.id === args[1] && entry.status === "UPLOADING");
    if (!row) return affected(0);
    Object.assign(row, { status: "FAILED", updated_at: args[0] });
    return affected(1);
  }
  if (/^UPDATE cinema_recordings SET status = 'FAILED', updated_at = \? WHERE id = \?$/.test(query)) {
    const row = state.recordings.find((entry) => entry.id === args[1]);
    if (!row) return affected(0);
    Object.assign(row, { status: "FAILED", updated_at: args[0] });
    return affected(1);
  }
  if (/^UPDATE cinema_recordings SET status = 'DELETING', updated_at = \? WHERE id = \? AND status <> 'DELETED'$/.test(query)) {
    const row = state.recordings.find((entry) => entry.id === args[1] && entry.status !== "DELETED");
    if (!row) return affected(0);
    Object.assign(row, { status: "DELETING", updated_at: args[0] });
    return affected(1);
  }
  if (/^UPDATE cinema_recordings SET status = 'DELETED', deleted_at = \?, updated_at = \? WHERE id = \? AND status = 'DELETING'$/.test(query)) {
    const row = state.recordings.find((entry) => entry.id === args[2] && entry.status === "DELETING");
    if (!row) return affected(0);
    Object.assign(row, { status: "DELETED", deleted_at: args[0], updated_at: args[1] });
    return affected(1);
  }
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  return { ok: true, json: async () => ({ results }) };
};

function fakeBucket(options = {}) {
  const objects = new Map();
  const handles = new Map();
  const handleFor = (key, uploadId, contentType) => ({
    key,
    uploadId,
    contentType,
    parts: new Map(),
    async uploadPart(partNumber, value) {
      if (options.failPart) throw new Error("the bucket refused the part");
      this.parts.set(partNumber, value);
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete(parts) {
      const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
      let total = 0;
      for (const part of ordered) total += this.parts.get(part.partNumber)?.byteLength || 0;
      const size = options.reportSize === undefined ? total : options.reportSize;
      objects.set(key, { size, contentType: this.contentType });
      handles.delete(this.uploadId);
      return { size };
    },
    async abort() { handles.delete(this.uploadId); options.aborted?.push(uploadId); },
  });
  return {
    objects,
    handles,
    async createMultipartUpload(key, init) {
      if (options.failMultipart) throw new Error("multipart is not available");
      const uploadId = `upload-${handles.size + 1}`;
      const handle = handleFor(key, uploadId, init?.httpMetadata?.contentType || "");
      handles.set(uploadId, handle);
      return handle;
    },
    resumeMultipartUpload(key, uploadId) {
      const handle = handles.get(uploadId);
      if (!handle) throw new Error(`no multipart upload ${uploadId}`);
      return handle;
    },
    async get(key) {
      const hit = objects.get(key);
      return hit ? { body: new Response(new Uint8Array(hit.size)).body, size: hit.size } : null;
    },
    async delete(key) {
      if (options.failDelete) throw new Error("the bucket refused the delete");
      for (const one of Array.isArray(key) ? key : [key]) objects.delete(one);
    },
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  abortCinemaRecording, beginCinemaRecording, cinemaRecordingForRecorder, cinemaRecordingKey,
  cinemaRecordingLimits, cinemaRecordingPartCount, completeCinemaRecording, deleteCinemaRecording,
  listCinemaRecordings, purgeCinemaRecordingsForRoom, purgeExpiredCinemaRecordings, putCinemaRecordingPart,
} = await vite.ssrLoadModule("/lib/cinema-engine/recordings.ts");
const { resetPlatformSettingsCache } = await vite.ssrLoadModule("/lib/platform-settings.ts");

const stamp = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeEach(() => {
  state.rooms = [{ id: "room-1", status: "LIVE" }];
  state.members = [
    { session_id: "room-1", student_id: "student-a", left_at: "" },
    { session_id: "room-1", student_id: "student-b", left_at: "" },
  ];
  state.recordings = [];
  state.metrics.clear();
  state.settings.clear();
  resetPlatformSettingsCache();
});

const begin = (input = {}) => beginCinemaRecording({
  roomId: "room-1", studentId: "student-a", mimeType: "audio/webm", sizeBytes: 40, durationSeconds: 12, ...input,
});

/** Records a whole take through the transport, as the browser does at stop. */
async function record(input = {}) {
  const bucket = input.bucket ?? fakeBucket();
  const opened = await begin({ ...input, bucket });
  const bytes = new Uint8Array(Number(input.sizeBytes ?? 40)).fill(7);
  const part = await putCinemaRecordingPart({
    recordingId: opened.recording.id, studentId: input.studentId ?? "student-a", partNumber: 1, body: bytes.buffer, bucket,
  });
  const finished = await completeCinemaRecording({ recordingId: opened.recording.id, studentId: input.studentId ?? "student-a", parts: [part], bucket });
  return { bucket, opened, finished };
}

test("a member records a take into their own private storage", async () => {
  const bucket = fakeBucket();
  const opened = await begin({ bucket });
  assert.equal(opened.parts, 1);
  assert.equal(opened.partBytes, 8 * 1024 * 1024);
  assert.equal(cinemaRecordingKey("room-1", opened.recording.id, "audio/webm"), `cinema/room-1/recordings/${opened.recording.id}/take.webm`);
  assert.equal(opened.recording.status, "UPLOADING");

  const bytes = new Uint8Array(40).fill(7);
  const part = await putCinemaRecordingPart({ recordingId: opened.recording.id, studentId: "student-a", partNumber: 1, body: bytes.buffer, bucket });
  const finished = await completeCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", parts: [part], bucket });
  assert.equal(finished.recording.status, "READY");
  assert.equal([...bucket.objects.keys()][0], `cinema/room-1/recordings/${opened.recording.id}/take.webm`);

  // The take is the recorder's: the same room does not list it for a peer.
  assert.equal((await listCinemaRecordings({ roomId: "room-1", studentId: "student-a" })).length, 1);
  assert.equal((await listCinemaRecordings({ roomId: "room-1", studentId: "student-b" })).length, 0);
  await assert.rejects(() => cinemaRecordingForRecorder({ recordingId: opened.recording.id, studentId: "student-b" }), /does not exist/);
});

test("a recording is refused for somebody who never joined the room", async () => {
  await assert.rejects(() => begin({ studentId: "student-c" }), /Join the room before recording/);
  await assert.rejects(() => begin({ roomId: "room-9" }), /does not exist/);
  state.rooms = [{ id: "room-1", status: "ENDED" }];
  await assert.rejects(() => begin(), /This room has ended/);
});

test("a deployment that switched recordings off refuses before R2 is touched", async () => {
  state.settings.set("cinema_recordings_enabled", "0");
  resetPlatformSettingsCache();
  const bucket = fakeBucket();
  await assert.rejects(() => begin({ bucket }), /switched off/);
  assert.equal(bucket.handles.size, 0, "nothing was opened in the bucket");
});

test("the bucket's own report decides the size, and a mismatch deletes the object", async () => {
  const bucket = fakeBucket({ reportSize: 999 });
  const opened = await begin({ bucket });
  const bytes = new Uint8Array(40).fill(7);
  const part = await putCinemaRecordingPart({ recordingId: opened.recording.id, studentId: "student-a", partNumber: 1, body: bytes.buffer, bucket });
  await assert.rejects(() => completeCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", parts: [part], bucket }), /does not match the size/);
  assert.equal(state.recordings[0].status, "FAILED");
  assert.equal(bucket.objects.size, 0, "the bad object is not left in the bucket");
});

test("a part that is not the size the take declared is refused before R2 sees it", async () => {
  const bucket = fakeBucket();
  const opened = await begin({ bucket, sizeBytes: 40 });
  await assert.rejects(
    () => putCinemaRecordingPart({ recordingId: opened.recording.id, studentId: "student-a", partNumber: 1, body: new Uint8Array(12).buffer, bucket }),
    /not the size/,
  );
  await assert.rejects(
    () => putCinemaRecordingPart({ recordingId: opened.recording.id, studentId: "student-a", partNumber: 2, body: new Uint8Array(40).buffer, bucket }),
    /not a part/,
  );
  await assert.rejects(() => begin({ bucket, sizeBytes: 3 * 1024 ** 3 }), /larger than this deployment/);
  await assert.rejects(() => begin({ bucket, mimeType: "audio/ogg" }), /does not keep/);
  assert.equal(cinemaRecordingPartCount(8 * 1024 * 1024 + 1), 2);
  assert.deepEqual((await cinemaRecordingLimits()).types.includes("video/webm"), true);
});

test("a take whose bytes never arrived is failed by the bucket's own report", async () => {
  const bucket = fakeBucket();
  const opened = await begin({ bucket, sizeBytes: 40 });
  await assert.rejects(
    () => completeCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", parts: [{ partNumber: 1, etag: "etag-1" }], bucket }),
    /does not match the size/,
  );
  assert.equal(state.recordings[0].status, "FAILED");
});

test("a multi-part take cannot be finished until every part is claimed", async () => {
  const bucket = fakeBucket();
  const opened = await begin({ bucket, sizeBytes: 8 * 1024 * 1024 + 1 });
  await assert.rejects(
    () => completeCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", parts: [{ partNumber: 1, etag: "etag-1" }], bucket }),
    /Every part/,
  );
  await assert.rejects(
    () => completeCinemaRecording({ recordingId: opened.recording.id, studentId: "student-b", parts: [{ partNumber: 1, etag: "etag-1" }], bucket }),
    /does not exist/,
  );
});

test("giving up on a take aborts the multipart and marks it failed", async () => {
  const aborted = [];
  const bucket = fakeBucket({ aborted });
  const opened = await begin({ bucket });
  const result = await abortCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", bucket });
  assert.equal(result.aborted, true);
  assert.equal(aborted.length, 1);
  assert.equal(state.recordings[0].status, "FAILED");
  assert.equal((await abortCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", bucket })).aborted, false);
});

test("the recorder deletes their own take, but only once the bucket has answered", async () => {
  const { opened, bucket } = await record();
  const refusing = fakeBucket({ failDelete: true });
  refusing.objects.set(`cinema/room-1/recordings/${opened.recording.id}/take.webm`, { size: 40 });
  await assert.rejects(() => deleteCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", bucket: refusing }), /refused the deletion/);
  assert.equal(state.recordings[0].status, "DELETING", "a row never says gone over bytes that are still there");

  const result = await deleteCinemaRecording({ recordingId: opened.recording.id, studentId: "student-a", bucket });
  assert.equal(result.deleted, true);
  assert.equal(state.recordings[0].status, "DELETED");
  assert.equal(bucket.objects.size, 0);
});

test("retention deletes takes past their window, and a refusal waits for the next run", async () => {
  const { opened, bucket } = await record();
  state.recordings[0].expires_at = stamp(90);
  const refusing = fakeBucket({ failDelete: true });
  refusing.objects.set(`cinema/room-1/recordings/${opened.recording.id}/take.webm`, { size: 40 });

  const blocked = await purgeExpiredCinemaRecordings({ now: Date.now(), bucket: refusing });
  assert.equal(blocked.deleted, 0);
  assert.equal(blocked.retry, true);
  assert.equal(state.recordings[0].status, "DELETING");

  const purged = await purgeExpiredCinemaRecordings({ now: Date.now(), bucket });
  assert.equal(purged.deleted, 1);
  assert.equal(state.recordings[0].status, "DELETED");
  assert.equal(bucket.objects.size, 0);

  // A take inside its window is untouched.
  await record({ studentId: "student-b" });
  const untouched = await purgeExpiredCinemaRecordings({ now: Date.now(), bucket });
  assert.equal(untouched.deleted, 0);
  assert.equal(state.recordings[1].status, "READY");
});

test("deleting a room takes every take with it, or asks the cleanup to try again", async () => {
  const first = await record();
  await record({ studentId: "student-b" });
  assert.equal(state.recordings.length, 2);

  const refusing = fakeBucket({ failDelete: true });
  for (const row of state.recordings) refusing.objects.set(row.r2_object_key, { size: row.file_size_bytes });
  const blocked = await purgeCinemaRecordingsForRoom("room-1", { now: Date.now(), bucket: refusing });
  assert.equal(blocked.status, "retry");

  const purged = await purgeCinemaRecordingsForRoom("room-1", { now: Date.now(), bucket: first.bucket });
  assert.equal(purged.status, "deleted");
  assert.equal(purged.deleted, 2);
  assert.equal(state.recordings.every((row) => row.status === "DELETED"), true);
  assert.equal((await purgeCinemaRecordingsForRoom("room-1", { now: Date.now(), bucket: first.bucket })).status, "absent");
});
