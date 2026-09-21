import { CampusEngineError } from "@/lib/campus-engine/errors";
import {
  CINEMA_UPLOAD_MAX_PARTS,
  CINEMA_UPLOAD_PART_BYTES,
  cinemaUploadBucket,
  type CinemaUploadBucket,
  type CinemaUploadPart,
} from "@/lib/cinema-engine/uploads";
import { incrementMetric, logEvent } from "@/lib/observability";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Cinema recordings: the recorder's own voice and camera, kept privately.
 *
 * A recording is not the room's video and is not a room artifact: it never
 * enters the playback path, it is never listed to anybody but the person who
 * made it, and it is uploaded at stop rather than streamed while it runs. That
 * last choice is deliberate — MediaRecorder hands over its bytes when it stops
 * — and the cost is honest: a tab that crashes mid-recording loses that take.
 *
 * The room is still told. A recording that captures other people's voices is a
 * fact the room has a right to see while it happens, so the socket carries the
 * recorder's flag and the UI shows it before the first byte is captured. The
 * consent question is asked where it matters, in the room, not buried here.
 *
 * Storage follows the upload rules: the same private bucket, the same part
 * size, the same retention window, and only the recorder can read the object
 * back — through the Worker, never through a public URL.
 */

export const CINEMA_RECORDING_SCHEMA_VERSION = "031_cinema_recordings";

export const CINEMA_RECORDING_STATUSES = ["UPLOADING", "READY", "DELETING", "DELETED", "FAILED"] as const;
export type CinemaRecordingStatus = (typeof CINEMA_RECORDING_STATUSES)[number];

/**
 * What the browsers' MediaRecorder actually produces: WebM on Chromium and
 * Firefox, MP4/M4A on Safari. A container the platform cannot reason about is
 * not accepted just because a browser could name it.
 */
export const CINEMA_RECORDING_TYPES = ["audio/webm", "video/webm", "audio/mp4", "video/mp4"] as const;

const CINEMA_RECORDING_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cinema_recordings (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    recorder_id TEXT NOT NULL,
    r2_object_key TEXT NOT NULL,
    r2_upload_id TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'UPLOADING',
    expires_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_recordings_session ON cinema_recordings(session_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_recordings_recorder ON cinema_recordings(recorder_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_recordings_status ON cinema_recordings(status, expires_at ASC)",
];

let recordingTablesReady: Promise<void> | null = null;

/** Memoised per isolate: a list read must not run DDL. */
export function ensureCinemaRecordingTables() {
  recordingTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaRecordings",
    version: CINEMA_RECORDING_SCHEMA_VERSION,
    statements: CINEMA_RECORDING_SCHEMA_STATEMENTS,
  }).catch((error: unknown) => {
    recordingTablesReady = null;
    throw error;
  });
  return recordingTablesReady;
}

const RECORDING_COLUMNS = `id,session_id,recorder_id,r2_object_key,COALESCE(r2_upload_id,'') AS r2_upload_id,
  COALESCE(mime_type,'') AS mime_type,COALESCE(file_size_bytes,0) AS file_size_bytes,
  COALESCE(duration_seconds,0) AS duration_seconds,COALESCE(status,'UPLOADING') AS status,
  COALESCE(expires_at,'') AS expires_at,COALESCE(deleted_at,'') AS deleted_at,created_at,updated_at`;

export type CinemaRecording = {
  id: string;
  sessionId: string;
  recorderId: string;
  objectKey: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSeconds: number;
  status: CinemaRecordingStatus;
  expiresAt: string;
  deletedAt: string;
  createdAt: string;
  updatedAt: string;
};

/** The metadata a recorder may see. The object key never leaves the server. */
export function publicCinemaRecording(recording: CinemaRecording) {
  return {
    id: recording.id,
    roomId: recording.sessionId,
    status: recording.status,
    mimeType: recording.mimeType,
    sizeBytes: recording.fileSizeBytes,
    durationSeconds: recording.durationSeconds,
    expiresAt: recording.expiresAt,
    createdAt: recording.createdAt,
  };
}

function recordingView(row: Record<string, unknown>): CinemaRecording {
  return {
    id: String(row.id || ""),
    sessionId: String(row.session_id || ""),
    recorderId: String(row.recorder_id || ""),
    objectKey: String(row.r2_object_key || ""),
    mimeType: String(row.mime_type || ""),
    fileSizeBytes: Number(row.file_size_bytes || 0),
    durationSeconds: Number(row.duration_seconds || 0),
    status: String(row.status || "UPLOADING") as CinemaRecordingStatus,
    expiresAt: String(row.expires_at || ""),
    deletedAt: String(row.deleted_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}

function recordingExtension(contentType: string) {
  if (contentType === "audio/mp4") return ".m4a";
  if (contentType === "video/mp4") return ".mp4";
  return ".webm";
}

/** `cinema/{session}/recordings/{recording}/take.webm`. */
export function cinemaRecordingKey(sessionId: string, recordingId: string, contentType: string) {
  return `cinema/${sessionId}/recordings/${recordingId}/take${recordingExtension(contentType)}`;
}

/** Whole parts a recording becomes, or 0 when the size cannot be split. */
export function cinemaRecordingPartCount(sizeBytes: number) {
  const size = Math.floor(Number(sizeBytes) || 0);
  if (size <= 0) return 0;
  return Math.ceil(size / CINEMA_UPLOAD_PART_BYTES);
}

/**
 * The public limits. Byte size is shared with video uploads — one bucket, one
 * cap — while the length is the recording's own switch.
 */
export async function cinemaRecordingLimits() {
  const maxBytes = Math.max(1, Math.floor(await platformSettingNumber("cinema_max_upload_bytes")));
  return {
    maxBytes,
    maxMinutes: Math.max(1, Math.floor(await platformSettingNumber("cinema_max_recording_minutes"))),
    partBytes: CINEMA_UPLOAD_PART_BYTES,
    maxParts: CINEMA_UPLOAD_MAX_PARTS,
    types: [...CINEMA_RECORDING_TYPES],
  };
}

/**
 * The recorder must be in the room they are recording. The read is one query
 * for the room and one for their membership; the room has to be open, because a
 * recording of a room that already ended is a file whose home is gone.
 */
async function requireRecordingRoom(input: { roomId: string; studentId: string }) {
  const room = rowsToObjects(await turso(
    "SELECT id,status FROM cinema_sessions WHERE id = ? AND status <> 'DELETED' LIMIT 1",
    [String(input.roomId)],
  ))[0];
  if (!room) throw new CampusEngineError("NOT_FOUND", "That room does not exist.", 404);
  const status = String(room.status || "");
  if (status !== "CREATED" && status !== "LIVE") throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  const member = rowsToObjects(await turso(
    "SELECT student_id FROM cinema_participants WHERE session_id = ? AND student_id = ? AND left_at = '' LIMIT 1",
    [String(input.roomId), String(input.studentId)],
  ))[0];
  if (!member) throw new CampusEngineError("FORBIDDEN", "Join the room before recording in it.", 403);
  return { id: String(room.id), status };
}

async function activeRecordingRow(recordingId: string, recorderId: string) {
  const row = rowsToObjects(await turso(
    `SELECT ${RECORDING_COLUMNS} FROM cinema_recordings WHERE id = ? AND recorder_id = ? LIMIT 1`,
    [String(recordingId), String(recorderId)],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That recording does not exist.", 404);
  if (String(row.status || "") !== "UPLOADING") {
    throw new CampusEngineError("INVALID_STATE", "That recording is no longer accepting parts.", 409);
  }
  return row;
}

async function abortMultipart(bucket: CinemaUploadBucket | null | undefined, key: string, uploadId: string) {
  if (!bucket || !key || !uploadId || typeof bucket.resumeMultipartUpload !== "function") return;
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  } catch (error) {
    logEvent("warn", "cinema_recording_abort_failed", { key, reason: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * Opens the multipart upload once the client has stopped recording and knows
 * the take's size. Nothing is written until R2 has accepted the upload, so a
 * failure leaves no half-row for a complete request to find.
 */
export async function beginCinemaRecording(input: {
  roomId: string;
  studentId: string;
  mimeType?: unknown;
  sizeBytes?: unknown;
  durationSeconds?: unknown;
  bucket?: CinemaUploadBucket | null;
  now?: number;
}): Promise<{ recording: CinemaRecording; partBytes: number; parts: number }> {
  await requireTurso();
  await ensureCinemaRecordingTables();
  if (!await platformSettingEnabled("cinema_recordings_enabled")) {
    throw new CampusEngineError("INVALID_STATE", "Recordings are switched off on this deployment.", 409);
  }
  await requireRecordingRoom({ roomId: input.roomId, studentId: input.studentId });

  const contentType = String(input.mimeType || "").trim().toLowerCase();
  if (!(CINEMA_RECORDING_TYPES as readonly string[]).includes(contentType)) {
    throw new CampusEngineError("VALIDATION_ERROR", "This browser recorded a format the platform does not keep.", 400);
  }
  const sizeBytes = Math.floor(Number(input.sizeBytes) || 0);
  const limits = await cinemaRecordingLimits();
  if (sizeBytes <= 0) throw new CampusEngineError("VALIDATION_ERROR", "That recording carries no bytes.", 400);
  if (sizeBytes > limits.maxBytes) {
    throw new CampusEngineError("VALIDATION_ERROR", "That recording is larger than this deployment accepts.", 413);
  }
  const parts = cinemaRecordingPartCount(sizeBytes);
  if (parts < 1 || parts > CINEMA_UPLOAD_MAX_PARTS) {
    throw new CampusEngineError("VALIDATION_ERROR", "That recording cannot be split into parts this browser can send.", 413);
  }
  const durationSeconds = Math.max(0, Math.min(
    Math.floor(Number(input.durationSeconds) || 0),
    limits.maxMinutes * 60,
  ));

  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket || typeof bucket.createMultipartUpload !== "function") {
    throw new CampusEngineError("CONFIG_REQUIRED", "Recordings need the private bucket binding.", 503);
  }

  const now = input.now ?? Date.now();
  const recordingId = crypto.randomUUID();
  const key = cinemaRecordingKey(String(input.roomId), recordingId, contentType);
  const multipart = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
  const stamp = new Date(now).toISOString();
  const retentionHours = Math.max(1, Math.floor(await platformSettingNumber("cinema_retention_hours")));
  await turso(
    `INSERT INTO cinema_recordings (id,session_id,recorder_id,r2_object_key,r2_upload_id,mime_type,file_size_bytes,duration_seconds,status,expires_at,deleted_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,'UPLOADING',?,'',?,?)`,
    [recordingId, String(input.roomId), String(input.studentId), key, String(multipart.uploadId || ""), contentType, sizeBytes, durationSeconds,
      new Date(now + retentionHours * 3_600_000).toISOString(), stamp, stamp],
  );
  logEvent("info", "cinema_recording_started", { roomId: String(input.roomId), recordingId, sizeBytes, contentType, parts });
  await incrementMetric("cinema_recordings_started");
  return {
    recording: recordingView({
      id: recordingId, session_id: String(input.roomId), recorder_id: String(input.studentId), r2_object_key: key,
      r2_upload_id: String(multipart.uploadId || ""), mime_type: contentType, file_size_bytes: sizeBytes,
      duration_seconds: durationSeconds, status: "UPLOADING", expires_at: "", deleted_at: "", created_at: stamp, updated_at: stamp,
    }),
    partBytes: CINEMA_UPLOAD_PART_BYTES,
    parts,
  };
}

/** One part of a take. The declared size bounds what R2 will ever hold. */
export async function putCinemaRecordingPart(input: {
  recordingId: string;
  studentId: string;
  partNumber?: unknown;
  body?: ArrayBuffer | null;
  bucket?: CinemaUploadBucket | null;
}): Promise<CinemaUploadPart> {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const row = await activeRecordingRow(String(input.recordingId), String(input.studentId));
  const sizeBytes = Number(row.file_size_bytes || 0);
  const parts = cinemaRecordingPartCount(sizeBytes);
  const partNumber = Math.floor(Number(input.partNumber) || 0);
  if (partNumber < 1 || partNumber > parts) {
    throw new CampusEngineError("VALIDATION_ERROR", "That is not a part of this recording.", 400);
  }
  const body = input.body;
  if (!body || body.byteLength < 1) throw new CampusEngineError("VALIDATION_ERROR", "That part carried no bytes.", 400);
  const expected = partNumber < parts ? CINEMA_UPLOAD_PART_BYTES : sizeBytes - (parts - 1) * CINEMA_UPLOAD_PART_BYTES;
  if (body.byteLength !== expected) {
    throw new CampusEngineError("VALIDATION_ERROR", "That part is not the size this recording agreed to.", 400);
  }
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket || typeof bucket.resumeMultipartUpload !== "function") {
    throw new CampusEngineError("CONFIG_REQUIRED", "Recordings need the private bucket binding.", 503);
  }
  const multipart = bucket.resumeMultipartUpload(String(row.r2_object_key), String(row.r2_upload_id || ""));
  const stored = await multipart.uploadPart(partNumber, body);
  return { partNumber, etag: String(stored?.etag || "") };
}

/**
 * Finishes the take. R2's report of the stored size is the authority, exactly
 * as it is for a room's video: a mismatch fails the recording and deletes the
 * object rather than handing back a file nobody can trust.
 */
export async function completeCinemaRecording(input: {
  recordingId: string;
  studentId: string;
  parts?: unknown;
  bucket?: CinemaUploadBucket | null;
}): Promise<{ recording: CinemaRecording }> {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const row = await activeRecordingRow(String(input.recordingId), String(input.studentId));
  const recordingId = String(row.id);
  const sizeBytes = Number(row.file_size_bytes || 0);
  const key = String(row.r2_object_key || "");
  const expectedParts = cinemaRecordingPartCount(sizeBytes);

  const supplied = Array.isArray(input.parts) ? input.parts : [];
  const parts: CinemaUploadPart[] = supplied.map((entry) => {
    const value = (entry || {}) as { partNumber?: unknown; etag?: unknown };
    return { partNumber: Math.floor(Number(value.partNumber) || 0), etag: String(value.etag || "").trim() };
  });
  const numbers = new Set(parts.map((part) => part.partNumber));
  if (parts.length !== expectedParts || numbers.size !== expectedParts
    || parts.some((part) => part.partNumber < 1 || part.partNumber > expectedParts || !part.etag)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Every part of the recording has to arrive before it can be finished.", 400);
  }
  parts.sort((left, right) => left.partNumber - right.partNumber);

  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket || typeof bucket.resumeMultipartUpload !== "function") {
    throw new CampusEngineError("CONFIG_REQUIRED", "Recordings need the private bucket binding.", 503);
  }
  const multipart = bucket.resumeMultipartUpload(key, String(row.r2_upload_id || ""));
  const object = await multipart.complete(parts);
  const storedSize = Math.floor(Number(object?.size ?? sizeBytes));
  const stamp = new Date().toISOString();
  if (storedSize !== sizeBytes) {
    try { await bucket.delete(key); } catch { /* the lifecycle rule is the second net */ }
    await turso("UPDATE cinema_recordings SET status = 'FAILED', updated_at = ? WHERE id = ?", [stamp, recordingId]);
    logEvent("warn", "cinema_recording_size_mismatch", { recordingId, declared: sizeBytes, stored: storedSize });
    await incrementMetric("cinema_recordings_failed");
    throw new CampusEngineError("VALIDATION_ERROR", "The recording that arrived does not match the size it declared.", 400);
  }
  await turso("UPDATE cinema_recordings SET status = 'READY', updated_at = ? WHERE id = ? AND status = 'UPLOADING'", [stamp, recordingId]);
  logEvent("info", "cinema_recording_ready", { recordingId, roomId: String(row.session_id || ""), sizeBytes });
  await incrementMetric("cinema_recordings_ready");
  return { recording: recordingView({ ...row, status: "READY", updated_at: stamp }) };
}

/** The recorder gives up on a take; nothing of it is left to complete. */
export async function abortCinemaRecording(input: {
  recordingId: string;
  studentId: string;
  bucket?: CinemaUploadBucket | null;
}): Promise<{ aborted: boolean }> {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const row = rowsToObjects(await turso(
    `SELECT ${RECORDING_COLUMNS} FROM cinema_recordings WHERE id = ? AND recorder_id = ? AND status = 'UPLOADING' LIMIT 1`,
    [String(input.recordingId), String(input.studentId)],
  ))[0];
  if (!row) return { aborted: false };
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  await abortMultipart(bucket, String(row.r2_object_key || ""), String(row.r2_upload_id || ""));
  if (bucket) { try { await bucket.delete(String(row.r2_object_key || "")); } catch { /* best effort */ } }
  await turso("UPDATE cinema_recordings SET status = 'FAILED', updated_at = ? WHERE id = ? AND status = 'UPLOADING'", [new Date().toISOString(), String(row.id)]);
  logEvent("info", "cinema_recording_aborted", { recordingId: String(row.id) });
  await incrementMetric("cinema_recordings_failed");
  return { aborted: true };
}

/** The recorder's takes in one room, newest first. Never anybody else's. */
export async function listCinemaRecordings(input: { roomId: string; studentId: string; limit?: number }): Promise<CinemaRecording[]> {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 20), 1), 50);
  const rows = rowsToObjects(await turso(
    `SELECT ${RECORDING_COLUMNS} FROM cinema_recordings
      WHERE session_id = ? AND recorder_id = ? AND status <> 'DELETED'
      ORDER BY created_at DESC LIMIT ${limit}`,
    [String(input.roomId), String(input.studentId)],
  ));
  return rows.map(recordingView);
}

/** One take, owned by the caller. The download route reads through this. */
export async function cinemaRecordingForRecorder(input: { recordingId: string; studentId: string }): Promise<CinemaRecording> {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const row = rowsToObjects(await turso(
    `SELECT ${RECORDING_COLUMNS} FROM cinema_recordings WHERE id = ? AND recorder_id = ? AND status <> 'DELETED' LIMIT 1`,
    [String(input.recordingId), String(input.studentId)],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That recording does not exist.", 404);
  return recordingView(row);
}

/**
 * The recorder deletes their own take. The object goes first and the row is
 * only marked deleted once the bucket has answered, so a failed delete cannot
 * leave a row that says gone over bytes that are still there.
 */
export async function deleteCinemaRecording(input: {
  recordingId: string;
  studentId: string;
  bucket?: CinemaUploadBucket | null;
  now?: number;
}): Promise<{ deleted: boolean }> {
  const recording = await cinemaRecordingForRecorder({ recordingId: input.recordingId, studentId: input.studentId });
  const stamp = new Date(input.now ?? Date.now()).toISOString();
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  const uploadId = recording.status === "UPLOADING"
    ? String((rowsToObjects(await turso(
      "SELECT r2_upload_id FROM cinema_recordings WHERE id = ? AND recorder_id = ? LIMIT 1",
      [recording.id, String(input.studentId)],
    ))[0]?.r2_upload_id) || "")
    : "";
  await turso("UPDATE cinema_recordings SET status = 'DELETING', updated_at = ? WHERE id = ? AND status <> 'DELETED'", [stamp, recording.id]);
  if (recording.status === "UPLOADING") await abortMultipart(bucket, recording.objectKey, uploadId);
  if (bucket) {
    try {
      await bucket.delete(recording.objectKey);
    } catch (error) {
      logEvent("warn", "cinema_recording_delete_failed", { recordingId: recording.id, reason: error instanceof Error ? error.message : "unknown" });
      throw new CampusEngineError("ENGINE_ERROR", "The bucket refused the deletion, so the recording is still there. Try again.", 502);
    }
  }
  await turso(
    "UPDATE cinema_recordings SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'DELETING'",
    [stamp, stamp, recording.id],
  );
  logEvent("info", "cinema_recording_deleted", { recordingId: recording.id, reason: "owner" });
  await incrementMetric("cinema_recordings_deleted");
  return { deleted: true };
}

/** The download body: the recorder's own object, streamed, never a URL. */
export async function cinemaRecordingObject(input: { recording: CinemaRecording; bucket?: CinemaUploadBucket | null }) {
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Recordings need the private bucket binding.", 503);
  const object = await bucket.get(input.recording.objectKey);
  if (!object?.body) throw new CampusEngineError("NOT_FOUND", "That recording's file is no longer in storage.", 404);
  return object;
}

/**
 * Retention for recordings whose room still exists. A recording is kept for
 * the same window as the room's own artifacts and then deleted by the cleanup
 * job; a bucket that refuses leaves the row READY and the next tick retries.
 */
export async function purgeExpiredCinemaRecordings(options: { limit?: number; now?: number; bucket?: CinemaUploadBucket | null } = {}) {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 20), 1), 100);
  const now = options.now ?? Date.now();
  const rows = rowsToObjects(await turso(
    `SELECT ${RECORDING_COLUMNS} FROM cinema_recordings
      WHERE status IN ('READY','FAILED','DELETING') AND expires_at <> '' AND expires_at <= ?
      ORDER BY expires_at ASC LIMIT ${limit}`,
    [new Date(now).toISOString()],
  ));
  const bucket = options.bucket === undefined ? await cinemaUploadBucket() : options.bucket;
  let deleted = 0;
  let retry = false;
  const stamp = new Date(now).toISOString();
  for (const raw of rows) {
    const recording = recordingView(raw);
    if (recording.status !== "DELETING") {
      await turso("UPDATE cinema_recordings SET status = 'DELETING', updated_at = ? WHERE id = ? AND status <> 'DELETED'", [stamp, recording.id]);
    }
    if (bucket) {
      try {
        await bucket.delete(recording.objectKey);
      } catch (error) {
        logEvent("warn", "cinema_recording_retention_failed", { recordingId: recording.id, reason: error instanceof Error ? error.message : "unknown" });
        retry = true;
        continue;
      }
    }
    await turso(
      "UPDATE cinema_recordings SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'DELETING'",
      [stamp, stamp, recording.id],
    );
    deleted += 1;
  }
  if (deleted) {
    logEvent("info", "cinema_recordings_expired", { deleted, retry });
    await incrementMetric("cinema_recordings_expired", deleted);
  }
  return { deleted, retry };
}

/**
 * The retention step when a room is deleted. Mirrors the upload purge: `retry`
 * means the bucket refused, and the caller leaves the room EXPIRED rather than
 * marking it deleted while a take is still in the bucket.
 */
export async function purgeCinemaRecordingsForRoom(sessionId: string, options: { bucket?: CinemaUploadBucket | null; now?: number } = {}) {
  await requireTurso();
  await ensureCinemaRecordingTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${RECORDING_COLUMNS} FROM cinema_recordings WHERE session_id = ? AND status <> 'DELETED' LIMIT 50`,
    [String(sessionId)],
  ));
  if (!rows.length) return { status: "absent" as const, deleted: 0 };
  const bucket = options.bucket === undefined ? await cinemaUploadBucket() : options.bucket;
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  let deleted = 0;
  for (const raw of rows) {
    const recording = recordingView(raw);
    await turso("UPDATE cinema_recordings SET status = 'DELETING', updated_at = ? WHERE id = ? AND status <> 'DELETED'", [stamp, recording.id]);
    if (recording.status === "UPLOADING") await abortMultipart(bucket, recording.objectKey, String(raw.r2_upload_id || ""));
    if (bucket) {
      try {
        await bucket.delete(recording.objectKey);
      } catch (error) {
        logEvent("warn", "cinema_recording_room_purge_failed", { roomId: String(sessionId), recordingId: recording.id, reason: error instanceof Error ? error.message : "unknown" });
        return { status: "retry" as const, deleted };
      }
    }
    await turso(
      "UPDATE cinema_recordings SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'DELETING'",
      [stamp, stamp, recording.id],
    );
    deleted += 1;
  }
  // A full page may hide more takes; ask the caller to run again next tick.
  if (rows.length === 50) return { status: "retry" as const, deleted };
  logEvent("info", "cinema_recordings_room_purged", { roomId: String(sessionId), deleted });
  await incrementMetric("cinema_recordings_deleted", deleted);
  return { status: "deleted" as const, deleted };
}
