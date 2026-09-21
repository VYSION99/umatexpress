import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema uploads: the multipart transport, the one-per-room rule, the size the
 * server enforces rather than believes, and the short-lived playback lease.
 *
 * The fake Turso keeps the rooms, membership and upload rows and refuses what it
 * was not taught, so a query change fails loudly. The fake bucket keeps real
 * multipart state — handles, parts, abort — because the rules being tested are
 * about what the bucket ends up holding.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-uploads-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const state = { rooms: [], members: [], uploads: [], metrics: new Map(), settings: new Map() };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const affected = (count) => ok({ affected_row_count: count });
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });

const ROOM_COLUMNS = ["id", "host_student_id", "title", "video_source_type", "video_id", "status", "join_locked", "started_at", "ended_at", "created_at", "updated_at"];
const MEMBER_COLUMNS = ["session_id", "student_id", "display_name", "joined_at", "last_seen_at", "left_at"];
const UPLOAD_COLUMNS = ["id", "session_id", "uploader_id", "r2_object_key", "r2_upload_id", "original_filename", "file_size_bytes", "mime_type", "duration_seconds", "ownership_confirmed", "status", "expires_at", "deleted_at", "created_at", "updated_at"];

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);
  if (/^ALTER TABLE/.test(sql)) return ok(empty);
  if (/^SELECT key, value, COALESCE\(updated_by,''\) AS updated_by/.test(sql)) {
    const rows = [...state.settings].map(([key, value]) => ({ key, value, updated_by: "", updated_at: "" }));
    return ok(rows.length ? table(["key", "value", "updated_by", "updated_at"], rows) : empty);
  }
  if (/^INSERT INTO metrics_counters/.test(sql)) {
    const [name, day, amount] = args;
    const key = `${name}:${day}`;
    state.metrics.set(key, (state.metrics.get(key) || 0) + Number(amount));
    return ok(table(["count"], [{ count: state.metrics.get(key) }]));
  }

  // The upload engine's lean room read.
  if (/^SELECT id,host_student_id,status,title FROM cinema_sessions WHERE id = \? AND status <> 'DELETED' LIMIT 1/.test(sql)) {
    const row = state.rooms.find((room) => room.id === args[0]);
    return ok(row ? table(["id", "host_student_id", "status", "title"], [row]) : empty);
  }
  // The room read the playback lease makes.
  if (/^SELECT id,host_student_id,title,video_source_type,video_id,status,join_locked,started_at,ended_at,created_at,updated_at FROM cinema_sessions WHERE id = \? LIMIT 1/.test(sql)) {
    const row = state.rooms.find((room) => room.id === args[0]);
    return ok(row ? table(ROOM_COLUMNS, [row]) : empty);
  }
  if (/^SELECT session_id,student_id,display_name,joined_at,last_seen_at,left_at FROM cinema_participants/.test(sql)) {
    const rows = state.members.filter((member) => args.includes(member.session_id));
    return ok(rows.length ? table(MEMBER_COLUMNS, rows) : empty);
  }
  if (/^SELECT session_id, COUNT\(\*\) AS members FROM cinema_participants/.test(sql)) {
    const grouped = new Map();
    for (const member of state.members) {
      if (!args.includes(member.session_id) || member.left_at) continue;
      grouped.set(member.session_id, (grouped.get(member.session_id) || 0) + 1);
    }
    const rows = [...grouped].map(([session_id, members]) => ({ session_id, members }));
    return ok(rows.length ? table(["session_id", "members"], rows) : empty);
  }
  if (/^UPDATE cinema_sessions SET video_source_type = 'UPLOAD', video_id = \?, updated_at = \? WHERE id = \?/.test(sql)) {
    const [videoId, updatedAt, id] = args;
    const room = state.rooms.find((row) => row.id === id);
    if (!room) return affected(0);
    Object.assign(room, { video_source_type: "UPLOAD", video_id: videoId, updated_at: updatedAt });
    return affected(1);
  }

  if (/^SELECT id,session_id,uploader_id,r2_object_key/.test(sql)) {
    const row = state.uploads.find((upload) => upload.session_id === args[0]);
    return ok(row ? table(UPLOAD_COLUMNS, [row]) : empty);
  }
  if (/^SELECT id,session_id,uploader_id,r2_object_key[\s\S]*AND status = 'UPLOADING' LIMIT 1/.test(sql)) {
    const row = state.uploads.find((upload) => upload.session_id === args[0] && upload.status === "UPLOADING");
    return ok(row ? table(UPLOAD_COLUMNS, [row]) : empty);
  }
  if (/^INSERT INTO cinema_uploads/.test(sql)) {
    const [id, sessionId, uploaderId, objectKey, uploadId, filename, sizeBytes, mimeType, expiresAt, createdAt, updatedAt] = args;
    state.uploads.push({
      id, session_id: sessionId, uploader_id: uploaderId, r2_object_key: objectKey, r2_upload_id: uploadId,
      original_filename: filename, file_size_bytes: sizeBytes, mime_type: mimeType, duration_seconds: 0,
      ownership_confirmed: 1, status: "UPLOADING", expires_at: expiresAt, deleted_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^UPDATE cinema_uploads SET status = 'READY', duration_seconds = \?, updated_at = \? WHERE id = \? AND status = 'UPLOADING'/.test(sql)) {
    const [duration, updatedAt, id] = args;
    const upload = state.uploads.find((row) => row.id === id && row.status === "UPLOADING");
    if (!upload) return affected(0);
    Object.assign(upload, { status: "READY", duration_seconds: duration, updated_at: updatedAt });
    return affected(1);
  }
  if (/^UPDATE cinema_uploads SET status = 'FAILED', duration_seconds = \?, updated_at = \? WHERE id = \?/.test(sql)) {
    const [duration, updatedAt, id] = args;
    const upload = state.uploads.find((row) => row.id === id);
    if (upload) Object.assign(upload, { status: "FAILED", duration_seconds: duration, updated_at: updatedAt });
    return affected(upload ? 1 : 0);
  }
  if (/^UPDATE cinema_uploads SET status = 'FAILED', updated_at = \? WHERE id = \?/.test(sql)) {
    const [updatedAt, id] = args;
    const upload = state.uploads.find((row) => row.id === id);
    if (upload) Object.assign(upload, { status: "FAILED", updated_at: updatedAt });
    return affected(upload ? 1 : 0);
  }
  if (/^UPDATE cinema_uploads SET status = 'DELETING'/.test(sql)) {
    const [updatedAt, id] = args;
    const upload = state.uploads.find((row) => row.id === id);
    if (upload) Object.assign(upload, { status: "DELETING", updated_at: updatedAt });
    return affected(upload ? 1 : 0);
  }
  if (/^UPDATE cinema_uploads SET status = 'DELETED', deleted_at = \?, updated_at = \? WHERE id = \? AND status = 'DELETING'/.test(sql)) {
    const [deletedAt, updatedAt, id] = args;
    const upload = state.uploads.find((row) => row.id === id && row.status === "DELETING");
    if (!upload) return affected(0);
    Object.assign(upload, { status: "DELETED", deleted_at: deletedAt, updated_at: updatedAt });
    return affected(1);
  }
  if (/^DELETE FROM cinema_uploads WHERE session_id = \?/.test(sql)) {
    const before = state.uploads.length;
    state.uploads = state.uploads.filter((upload) => upload.session_id !== args[0]);
    return affected(before - state.uploads.length);
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

/**
 * R2's multipart surface as the engine uses it: handles that keep their parts,
 * an object that appears only on complete, and a delete that is honest about
 * failing when a test asks it to.
 */
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
      const merged = new Uint8Array(total);
      let at = 0;
      for (const part of ordered) {
        const chunk = new Uint8Array(this.parts.get(part.partNumber));
        merged.set(chunk, at);
        at += chunk.byteLength;
      }
      const size = options.reportSize === undefined ? total : options.reportSize;
      objects.set(key, { bytes: merged, size, contentType: this.contentType });
      handles.delete(this.uploadId);
      return { size };
    },
    async abort() {
      handles.delete(this.uploadId);
      options.aborted?.push(uploadId);
    },
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
    async get(key, init) {
      const hit = objects.get(key);
      if (!hit) return null;
      const range = init?.range;
      const bytes = range ? hit.bytes.slice(range.offset, range.offset + range.length) : hit.bytes;
      return { body: new Response(bytes).body, size: hit.size, httpMetadata: { contentType: hit.contentType } };
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
  CINEMA_UPLOAD_PART_BYTES, abortCinemaUpload, beginCinemaUpload, cinemaUploadKey,
  cinemaUploadLimits, completeCinemaUpload, parseMp4Duration, purgeCinemaUploadForRoom, putCinemaUploadPart,
} = await vite.ssrLoadModule("/lib/cinema-engine/uploads.ts");
const {
  issueCinemaPlayback, parseCinemaByteRange, readCinemaMediaObject, signCinemaMediaToken, verifyCinemaMediaToken, cinemaUploadForToken,
} = await vite.ssrLoadModule("/lib/cinema-engine/media.ts");
const { resetPlatformSettingsCache } = await vite.ssrLoadModule("/lib/platform-settings.ts");

const stamp = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** An MP4 head with one `mvhd`, which is all the duration reader looks for. */
function mp4Head(seconds, { timescale = 1000, version = 0 } = {}) {
  const bodyLength = version === 1 ? 32 : 20;
  const atom = 8 + bodyLength;
  const bytes = new Uint8Array(16 + 8 + atom);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 16); bytes.set(new TextEncoder().encode("ftyp"), 4);
  view.setUint32(16, 8 + atom); bytes.set(new TextEncoder().encode("moov"), 20);
  const mvhd = 24;
  view.setUint32(mvhd, atom); bytes.set(new TextEncoder().encode("mvhd"), mvhd + 4);
  view.setUint8(mvhd + 8, version);
  if (version === 1) {
    view.setUint32(mvhd + 28, timescale);
    view.setBigUint64(mvhd + 32, BigInt(Math.round(seconds * timescale)));
  } else {
    view.setUint32(mvhd + 20, timescale);
    view.setUint32(mvhd + 24, Math.round(seconds * timescale));
  }
  return bytes;
}

function room(overrides = {}) {
  return {
    id: "room-1", host_student_id: "host-a", title: "Signals", video_source_type: "YOUTUBE", video_id: "M7lc1UVf-VE",
    status: "LIVE", join_locked: 0, started_at: stamp(30), ended_at: "", created_at: stamp(60), updated_at: stamp(1), ...overrides,
  };
}

beforeEach(() => {
  state.rooms = [room()];
  state.members = [{ session_id: "room-1", student_id: "host-a", display_name: "Ama Host", joined_at: stamp(60), last_seen_at: stamp(1), left_at: "" }];
  state.uploads = [];
  state.metrics.clear();
  state.settings.clear();
  resetPlatformSettingsCache();
});

const begin = (input = {}) => beginCinemaUpload({
  roomId: "room-1", studentId: "host-a", filename: "lecture.mp4", sizeBytes: 52,
  contentType: "video/mp4", ownershipConfirmed: true, ...input,
});

test("an MP4 head gives up its length, and a container that hides it gives nothing", () => {
  assert.equal(parseMp4Duration(mp4Head(92)), 92);
  assert.equal(parseMp4Duration(mp4Head(61.5, { timescale: 600 })), 62, "a 600-timescale header rounds to the second");
  assert.equal(parseMp4Duration(mp4Head(120, { version: 1 })), 120, "v1 headers carry 64-bit durations");
  assert.equal(parseMp4Duration(new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101])), 0, "no moov is an unknown length");
  assert.equal(parseMp4Duration(new Uint8Array()), 0);
});

test("a byte range is resolved against the object, and a nonsense one is refused", () => {
  assert.equal(parseCinemaByteRange("", 100), null, "no header is the whole object");
  assert.deepEqual(parseCinemaByteRange("bytes=0-99", 100), { offset: 0, length: 100 });
  assert.deepEqual(parseCinemaByteRange("bytes=10-", 100), { offset: 10, length: 90 });
  assert.deepEqual(parseCinemaByteRange("bytes=-10", 100), { offset: 90, length: 10 });
  assert.deepEqual(parseCinemaByteRange("bytes=90-200", 100), { offset: 90, length: 10 }, "an end past the object is clipped");
  assert.equal(parseCinemaByteRange("bytes=100-", 100), "invalid");
  assert.equal(parseCinemaByteRange("bytes=50-10", 100), "invalid");
  assert.equal(parseCinemaByteRange("items=0-10", 100), "invalid");
});

test("only the host starts an upload, and only after saying the video is theirs", async () => {
  const guest = await beginCinemaUpload({ roomId: "room-1", studentId: "guest-a", sizeBytes: 52, contentType: "video/mp4", ownershipConfirmed: true, bucket: fakeBucket() })
    .then(() => null, (error) => error);
  assert.equal(guest?.code, "FORBIDDEN");

  const unowned = await begin({ ownershipConfirmed: false, bucket: fakeBucket() }).then(() => null, (error) => error);
  assert.equal(unowned?.code, "VALIDATION_ERROR");
  assert.equal(state.uploads.length, 0, "nothing was written");

  const wrongType = await begin({ contentType: "application/pdf", bucket: fakeBucket() }).then(() => null, (error) => error);
  assert.equal(wrongType?.code, "VALIDATION_ERROR");

  const tooBig = await begin({ sizeBytes: 2 * 1024 ** 3 + 1, bucket: fakeBucket() }).then(() => null, (error) => error);
  assert.equal(tooBig?.code, "VALIDATION_ERROR");

  const missingRoom = await beginCinemaUpload({ roomId: "room-9", studentId: "host-a", sizeBytes: 52, contentType: "video/mp4", ownershipConfirmed: true, bucket: fakeBucket() })
    .then(() => null, (error) => error);
  assert.equal(missingRoom?.code, "NOT_FOUND");
});

test("an upload is one row, one key, and as many parts as the size needs", async () => {
  const bucket = fakeBucket();
  const started = await begin({ bucket });
  assert.equal(started.parts, 1);
  assert.equal(started.partBytes, CINEMA_UPLOAD_PART_BYTES);
  assert.equal(started.upload.status, "UPLOADING");
  assert.equal(started.upload.objectKey, cinemaUploadKey("room-1", started.upload.id, "video/mp4"));
  assert.match(started.upload.objectKey, /^cinema\/room-1\/video\//);
  assert.ok(started.upload.expiresAt, "the row records the earliest eligible deletion");
  assert.equal(state.uploads.length, 1);
  assert.equal(bucket.handles.size, 1);

  const limits = await cinemaUploadLimits();
  assert.equal(limits.maxBytes, 2 * 1024 ** 3);
  assert.deepEqual(limits.types, ["video/mp4", "video/quicktime", "video/webm"]);

  const multi = await begin({ sizeBytes: CINEMA_UPLOAD_PART_BYTES + 100, bucket });
  assert.equal(multi.parts, 2, "a part-sized file plus a remainder is two parts");
});

test("a room that already plays a video refuses another, and a failed one is replaced", async () => {
  const aborted = [];
  const bucket = fakeBucket({ aborted });
  const started = await begin({ bucket });
  state.uploads[0].status = "READY";
  const refused = await begin({ bucket }).then(() => null, (error) => error);
  assert.equal(refused?.code, "INVALID_STATE");
  assert.equal(state.uploads[0].id, started.upload.id, "the ready upload was left alone");

  state.uploads[0].status = "UPLOADING";
  const second = await begin({ bucket });
  assert.notEqual(second.upload.id, started.upload.id, "the stale upload made way for the new one");
  assert.equal(state.uploads.length, 1);
  assert.equal(aborted.length, 1, "the old multipart upload was aborted rather than left billing");
});

test("a part has to be exactly the size the upload agreed to", async () => {
  const bucket = fakeBucket();
  const started = await begin({ sizeBytes: CINEMA_UPLOAD_PART_BYTES + 52, bucket });
  const short = await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 1, body: new Uint8Array(10).buffer, bucket })
    .then(() => null, (error) => error);
  assert.equal(short?.code, "VALIDATION_ERROR");
  assert.equal(bucket.handles.get(state.uploads[0].r2_upload_id).parts.size, 0, "the bucket never saw it");

  const good = await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 1, body: new Uint8Array(CINEMA_UPLOAD_PART_BYTES).buffer, bucket });
  assert.deepEqual(good, { partNumber: 1, etag: "etag-1" });

  const missing = await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 3, body: new Uint8Array(10).buffer, bucket })
    .then(() => null, (error) => error);
  assert.equal(missing?.code, "VALIDATION_ERROR", "there is no third part in a two-part file");
  assert.ok(started.parts === 2);
});

test("finishing checks R2's own report, and the room only then points at the video", async () => {
  const bucket = fakeBucket();
  const started = await begin({ bucket, sizeBytes: 52 });
  const incomplete = await completeCinemaUpload({ roomId: "room-1", studentId: "host-a", parts: [], bucket })
    .then(() => null, (error) => error);
  assert.equal(incomplete?.code, "VALIDATION_ERROR");

  const file = mp4Head(92);
  await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 1, body: file.buffer.slice(0, file.byteLength), bucket });
  const finished = await completeCinemaUpload({ roomId: "room-1", studentId: "host-a", parts: [{ partNumber: 1, etag: "etag-1" }], bucket });
  assert.equal(finished.upload.status, "READY");
  assert.equal(finished.durationSeconds, 92, "the length came from the object, not from the client");
  assert.equal(state.rooms[0].video_source_type, "UPLOAD");
  assert.equal(state.rooms[0].video_id, started.upload.id);
  assert.equal(bucket.objects.size, 1);
});

test("a stored size that disagrees with the declared one fails the upload, not the room", async () => {
  const bucket = fakeBucket({ reportSize: 999 });
  await begin({ bucket, sizeBytes: 52 });
  const file = mp4Head(92);
  await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 1, body: file.buffer.slice(0, file.byteLength), bucket });
  const error = await completeCinemaUpload({ roomId: "room-1", studentId: "host-a", parts: [{ partNumber: 1, etag: "etag-1" }], bucket })
    .then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "VALIDATION_ERROR");
  assert.equal(state.uploads[0].status, "FAILED");
  assert.equal(bucket.objects.size, 0, "the object that arrived is gone");
  assert.equal(state.rooms[0].video_source_type, "YOUTUBE", "the room is unchanged");
});

test("a video longer than the deployment allows is refused after the header says so", async () => {
  state.settings.set("cinema_max_upload_minutes", "1");
  resetPlatformSettingsCache();
  const bucket = fakeBucket();
  await begin({ bucket, sizeBytes: 52 });
  const file = mp4Head(600);
  await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 1, body: file.buffer.slice(0, file.byteLength), bucket });
  const error = await completeCinemaUpload({ roomId: "room-1", studentId: "host-a", parts: [{ partNumber: 1, etag: "etag-1" }], bucket })
    .then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "VALIDATION_ERROR");
  assert.equal(state.uploads[0].status, "FAILED");
  assert.equal(bucket.objects.size, 0);
});

test("an upload can be given up on, and nothing of it is left to complete", async () => {
  const bucket = fakeBucket();
  const started = await begin({ bucket });
  const result = await abortCinemaUpload({ roomId: "room-1", studentId: "host-a", bucket });
  assert.equal(result.aborted, true);
  assert.equal(state.uploads[0].status, "FAILED");
  assert.equal(bucket.handles.size, 0, "the multipart upload was aborted");
  assert.equal(state.uploads[0].id, started.upload.id);
});

test("retention deletes the object first, and a refusing bucket leaves the work for the next tick", async () => {
  const bucket = fakeBucket();
  await begin({ bucket, sizeBytes: 52 });
  const file = mp4Head(92);
  await putCinemaUploadPart({ roomId: "room-1", studentId: "host-a", partNumber: 1, body: file.buffer.slice(0, file.byteLength), bucket });
  await completeCinemaUpload({ roomId: "room-1", studentId: "host-a", parts: [{ partNumber: 1, etag: "etag-1" }], bucket });

  const refusing = fakeBucket({ failDelete: true });
  refusing.objects.set(state.uploads[0].r2_object_key, { bytes: file, size: 52, contentType: "video/mp4" });
  const retry = await purgeCinemaUploadForRoom("room-1", { bucket: refusing });
  assert.equal(retry.status, "retry");
  assert.equal(state.uploads[0].status, "DELETING", "the row says the deletion is unfinished");

  const done = await purgeCinemaUploadForRoom("room-1", { bucket });
  assert.equal(done.status, "deleted");
  assert.equal(state.uploads[0].status, "DELETED");
  assert.ok(state.uploads[0].deleted_at);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await purgeCinemaUploadForRoom("room-1", { bucket })).status, "absent", "a second purge has nothing to do");
});

test("a playback lease is signed, tamper-evident and short-lived", async () => {
  const lease = await signCinemaMediaToken({ roomId: "room-1", uploadId: "upload-1", studentId: "host-a" });
  const claims = await verifyCinemaMediaToken(lease.token);
  assert.equal(claims?.roomId, "room-1");
  assert.equal(claims?.uploadId, "upload-1");
  assert.equal(claims?.studentId, "host-a");
  assert.ok(lease.expiresInSeconds > 0);

  const [payload, signature] = lease.token.split(".");
  assert.equal(await verifyCinemaMediaToken(`${payload}.${signature.slice(0, -2)}xy`), null, "a tampered signature is refused");
  assert.equal(await verifyCinemaMediaToken(`${payload}x.${signature}`), null, "a tampered payload is refused");
  assert.equal(await verifyCinemaMediaToken("not-a-token"), null);

  const expired = await signCinemaMediaToken({ roomId: "room-1", uploadId: "upload-1", studentId: "host-a", now: Date.now() - 3_600_000, ttlSeconds: 60 });
  assert.equal(await verifyCinemaMediaToken(expired.token), null);
});

test("a member of an open room gets a lease, and nobody else does", async () => {
  const bucket = fakeBucket();
  const started = await begin({ bucket });
  state.uploads[0].status = "READY";
  state.members.push({ session_id: "room-1", student_id: "guest-a", display_name: "Kwesi", joined_at: stamp(5), last_seen_at: stamp(1), left_at: "" });

  const lease = await issueCinemaPlayback({ roomId: "room-1", studentId: "guest-a" });
  assert.match(lease.url, /^\/api\/cinema\/media\//);
  const claims = await verifyCinemaMediaToken(lease.url.split("/").pop());
  assert.equal(claims?.studentId, "guest-a");
  assert.equal(claims?.uploadId, started.upload.id);
  assert.equal(lease.upload.sizeBytes, 52);

  const stranger = await issueCinemaPlayback({ roomId: "room-1", studentId: "stranger" }).then(() => null, (error) => error);
  assert.equal(stranger?.code, "FORBIDDEN");

  state.rooms[0].status = "ENDED";
  const ended = await issueCinemaPlayback({ roomId: "room-1", studentId: "host-a" }).then(() => null, (error) => error);
  assert.equal(ended?.code, "INVALID_STATE");
});

test("a lease names the upload the row still holds, and serves the range it asked for", async () => {
  const bucket = fakeBucket();
  const bytes = new Uint8Array(64).map((_, index) => index);
  const started = await begin({ bucket, sizeBytes: 64 });
  state.uploads[0].status = "READY";
  state.uploads[0].file_size_bytes = 64;
  bucket.objects.set(started.upload.objectKey, { bytes, size: 64, contentType: "video/mp4" });

  const stale = await cinemaUploadForToken({ roomId: "room-1", uploadId: "another-upload", studentId: "host-a", expiresAt: Date.now() + 1000 })
    .then(() => null, (error) => error);
  assert.equal(stale?.code, "NOT_FOUND");

  const upload = await cinemaUploadForToken({ roomId: "room-1", uploadId: started.upload.id, studentId: "host-a", expiresAt: Date.now() + 1000 });
  const whole = await readCinemaMediaObject({ upload, bucket });
  assert.equal(whole.partial, false);
  assert.equal(whole.length, 64);
  assert.equal((await new Response(whole.body).arrayBuffer()).byteLength, 64);

  const part = await readCinemaMediaObject({ upload, range: { offset: 8, length: 4 }, bucket });
  assert.equal(part.partial, true);
  assert.deepEqual([...new Uint8Array(await new Response(part.body).arrayBuffer())], [8, 9, 10, 11]);

  const gone = await readCinemaMediaObject({ upload, bucket: fakeBucket() });
  assert.equal(gone, null, "an object the retention job deleted answers nothing");
});
