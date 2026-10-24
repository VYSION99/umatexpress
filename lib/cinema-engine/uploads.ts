import { CampusEngineError } from "@/lib/campus-engine/errors";
import { privateBucket } from "@/lib/cloudflare-bindings";
import { consoleAudit } from "@/lib/console-audit";
import { announceCinemaSource, scheduleCinemaRoom } from "@/lib/cinema-engine/realtime";
import { incrementMetric, logEvent } from "@/lib/observability";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";
import { cinemaRoomAllowance, snapshotCinemaRoomAllowance } from "@/lib/cinema-engine/room-plans";

/**
 * Cinema uploads: an ordered, plan-limited private playlist per room.
 *
 * The transport is the decision recorded in §17 of docs/Cinema: the client
 * splits the file into parts and sends each part through the Worker, which
 * writes it with the R2 binding. No S3 key pair exists, so there is nothing to
 * presign — and because every byte passes the membership and room checks, an
 * upload stops the moment the room does rather than living behind a URL that
 * was already handed out.
 *
 * The rules the rest of the platform keeps hold here: one active upload, the
 * server's word on size and status, and nothing the uploader claims is trusted
 * when the stored object can answer instead. The object key never travels to a
 * client; playback goes through a short-lived signed URL (media.ts).
 */

export const CINEMA_UPLOAD_SCHEMA_VERSION = "043_cinema_upload_playlist";

export const CINEMA_UPLOAD_STATUSES = ["UPLOADING", "READY", "DELETING", "DELETED", "FAILED"] as const;
export type CinemaUploadStatus = (typeof CINEMA_UPLOAD_STATUSES)[number];

/** Formats the documented browser-playable set, and no others. */
export const CINEMA_UPLOAD_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

/** Eight mebibytes per part: far under the Worker request limit, few enough parts for 2 GB. */
export const CINEMA_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
/** R2 multipart's own ceiling; a file needing more parts is past every limit here anyway. */
export const CINEMA_UPLOAD_MAX_PARTS = 10_000;

const CINEMA_UPLOAD_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cinema_uploads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    uploader_id TEXT NOT NULL,
    r2_object_key TEXT NOT NULL,
    r2_upload_id TEXT NOT NULL DEFAULT '',
    original_filename TEXT NOT NULL DEFAULT '',
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    ownership_confirmed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'UPLOADING',
    expires_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_uploads_status ON cinema_uploads(status, created_at DESC)",
  // A moderator's removal is remembered on the row, and only a moderator's:
  // retention deletes the object without setting `removed_by`, which is what
  // keeps an expired room from counting as a strike against its host.
  "ALTER TABLE cinema_uploads ADD COLUMN removed_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE cinema_uploads ADD COLUMN removed_reason TEXT NOT NULL DEFAULT ''",
  "DROP INDEX IF EXISTS idx_cinema_uploads_session",
  "ALTER TABLE cinema_uploads ADD COLUMN playlist_position INTEGER NOT NULL DEFAULT 1",
  "CREATE INDEX IF NOT EXISTS idx_cinema_uploads_playlist ON cinema_uploads(session_id,playlist_position)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_uploads_active_position ON cinema_uploads(session_id,playlist_position) WHERE status IN ('READY','UPLOADING')",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_uploads_one_inflight ON cinema_uploads(session_id) WHERE status = 'UPLOADING'",
];

let uploadTablesReady: Promise<void> | null = null;

/** Memoised per isolate: a playback read must not run DDL. */
export function ensureCinemaUploadTables() {
  uploadTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaUploads",
    version: CINEMA_UPLOAD_SCHEMA_VERSION,
    statements: CINEMA_UPLOAD_SCHEMA_STATEMENTS,
  }).catch((error: unknown) => {
    uploadTablesReady = null;
    throw error;
  });
  return uploadTablesReady;
}

/** Only what the transport actually uses; the binding is typed structurally. */
export type CinemaUploadPart = { partNumber: number; etag: string };
export type CinemaMultipartUpload = {
  uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<CinemaUploadPart>;
  complete(parts: CinemaUploadPart[]): Promise<{ size?: number } | null>;
  abort(): Promise<void>;
};
export type CinemaUploadBucket = {
  createMultipartUpload(key: string, options?: Record<string, unknown>): Promise<CinemaMultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): CinemaMultipartUpload;
  get(key: string, options?: Record<string, unknown>): Promise<{ body?: ReadableStream; size?: number } | null>;
  delete(key: string | string[]): Promise<void>;
};

const UPLOAD_COLUMNS = `id,session_id,uploader_id,r2_object_key,COALESCE(r2_upload_id,'') AS r2_upload_id,
  COALESCE(original_filename,'') AS original_filename,COALESCE(file_size_bytes,0) AS file_size_bytes,
  COALESCE(mime_type,'') AS mime_type,COALESCE(duration_seconds,0) AS duration_seconds,
  COALESCE(ownership_confirmed,0) AS ownership_confirmed,COALESCE(status,'UPLOADING') AS status,
  COALESCE(expires_at,'') AS expires_at,COALESCE(deleted_at,'') AS deleted_at,
  COALESCE(removed_by,'') AS removed_by,COALESCE(removed_reason,'') AS removed_reason,
  COALESCE(playlist_position,1) AS playlist_position,created_at,updated_at`;

export type CinemaUpload = {
  id: string;
  sessionId: string;
  uploaderId: string;
  objectKey: string;
  originalFilename: string;
  fileSizeBytes: number;
  mimeType: string;
  durationSeconds: number;
  ownershipConfirmed: boolean;
  status: CinemaUploadStatus;
  expiresAt: string;
  deletedAt: string;
  /** Set only by a moderator's takedown; empty for retention and failures. */
  removedBy: string;
  removedReason: string;
  createdAt: string;
  updatedAt: string;
  playlistPosition: number;
};

function uploadView(row: Record<string, unknown>): CinemaUpload {
  return {
    id: String(row.id || ""),
    sessionId: String(row.session_id || ""),
    uploaderId: String(row.uploader_id || ""),
    objectKey: String(row.r2_object_key || ""),
    originalFilename: String(row.original_filename || ""),
    fileSizeBytes: Number(row.file_size_bytes || 0),
    mimeType: String(row.mime_type || ""),
    durationSeconds: Number(row.duration_seconds || 0),
    ownershipConfirmed: Number(row.ownership_confirmed || 0) === 1,
    status: String(row.status || "UPLOADING") as CinemaUploadStatus,
    expiresAt: String(row.expires_at || ""),
    deletedAt: String(row.deleted_at || ""),
    removedBy: String(row.removed_by || ""),
    removedReason: String(row.removed_reason || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    playlistPosition: Number(row.playlist_position || 1),
  };
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}

/** The room a host may upload into: visible, active, and theirs. One query. */
async function requireUploadRoom(roomId: string, studentId: string) {
  const row = rowsToObjects(await turso(
    "SELECT id,host_student_id,status,title,video_source_type,visibility FROM cinema_sessions WHERE id = ? AND status <> 'DELETED' LIMIT 1",
    [String(roomId)],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That room does not exist.", 404);
  if (String(row.host_student_id || "") !== String(studentId || "")) {
    throw new CampusEngineError("FORBIDDEN", "Only the host can upload to this room.", 403);
  }
  const status = String(row.status || "");
  if (status !== "CREATED" && status !== "LIVE") {
    throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  }
  if (String(row.video_source_type || "") !== "UPLOAD") {
    throw new CampusEngineError("INVALID_STATE", "Files can only be added to a file room.", 409);
  }
  return { id: String(row.id), title: String(row.title || ""), status };
}

/** The public limits, so a client can validate before it sends a byte. */
export async function cinemaUploadLimits() {
  const maxBytes = Math.max(1, Math.floor(await platformSettingNumber("cinema_max_upload_bytes")));
  return {
    maxBytes,
    maxMinutes: Math.max(1, Math.floor(await platformSettingNumber("cinema_max_upload_minutes"))),
    partBytes: CINEMA_UPLOAD_PART_BYTES,
    maxParts: CINEMA_UPLOAD_MAX_PARTS,
    types: [...CINEMA_UPLOAD_TYPES],
  };
}

/** Whole parts a declared size becomes, or null when the size cannot be split. */
export function cinemaUploadPartCount(sizeBytes: number) {
  const size = Math.floor(Number(sizeBytes) || 0);
  if (size <= 0) return 0;
  return Math.ceil(size / CINEMA_UPLOAD_PART_BYTES);
}

export async function cinemaUploadForRoom(roomId: string): Promise<CinemaUpload | null> {
  await requireTurso();
  await ensureCinemaUploadTables();
  const row = rowsToObjects(await turso(
    `SELECT ${UPLOAD_COLUMNS} FROM cinema_uploads WHERE session_id = ? AND id = (SELECT video_id FROM cinema_sessions WHERE id = ?) LIMIT 1`,
    [String(roomId), String(roomId)],
  ))[0];
  return row ? uploadView(row) : null;
}

export async function cinemaUploadsForRoom(roomId: string): Promise<CinemaUpload[]> {
  await requireTurso();
  await ensureCinemaUploadTables();
  return rowsToObjects(await turso(
    `SELECT ${UPLOAD_COLUMNS} FROM cinema_uploads WHERE session_id = ? AND status IN ('READY','UPLOADING') ORDER BY playlist_position,created_at`,
    [String(roomId)],
  )).map(uploadView);
}

/** Move from the source the host actually watched; repeated end events are safe. */
export async function advanceCinemaPlaylist(input: { roomId: string; studentId: string; currentUploadId: string }) {
  const room = rowsToObjects(await turso(
    "SELECT host_student_id,status,video_source_type FROM cinema_sessions WHERE id = ? LIMIT 1", [input.roomId],
  ))[0];
  if (!room || !["CREATED", "LIVE"].includes(String(room.status || "")) || String(room.video_source_type || "") !== "UPLOAD") {
    throw new CampusEngineError("INVALID_STATE", "This private playlist is no longer active.", 409);
  }
  if (String(room.host_student_id || "") !== input.studentId) {
    const member = rowsToObjects(await turso(
      "SELECT role FROM cinema_participants WHERE session_id = ? AND student_id = ? AND left_at = '' LIMIT 1",
      [input.roomId, input.studentId],
    ))[0];
    if (String(member?.role || "") !== "COHOST") throw new CampusEngineError("FORBIDDEN", "Only the host or a co-host can advance this playlist.", 403);
  }
  await ensureCinemaUploadTables();
  const current = await cinemaUploadForRoom(input.roomId);
  if (!current || current.id !== input.currentUploadId) {
    throw new CampusEngineError("INVALID_STATE", "The playlist has already moved on.", 409);
  }
  const uploads = await cinemaUploadsForRoom(input.roomId);
  const next = uploads.find((entry) => entry.status === "READY" && entry.playlistPosition > current.playlistPosition) || null;
  const result = await turso(
    "UPDATE cinema_sessions SET video_id = ?, updated_at = ? WHERE id = ? AND video_id = ? AND status IN ('CREATED','LIVE')",
    [next?.id || "", new Date().toISOString(), input.roomId, current.id],
  );
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("INVALID_STATE", "The playlist changed. Refresh the room.", 409);
  await announceCinemaSource(input.roomId, { sourceType: "UPLOAD", videoId: next?.id || "" });
  return { next: next ? { id: next.id, filename: next.originalFilename } : null, phase: next ? "SCREENING" : "DISCUSSION" };
}

/** The host may reorder files that have not started; the active file stays put. */
export async function reorderCinemaPlaylist(input: { roomId: string; studentId: string; uploadIds: string[] }) {
  await requireUploadRoom(input.roomId, input.studentId);
  const current = await cinemaUploadForRoom(input.roomId);
  if (!current) throw new CampusEngineError("INVALID_STATE", "The screening has finished.", 409);
  const all = await cinemaUploadsForRoom(input.roomId);
  if (all.some((entry) => entry.status === "UPLOADING")) throw new CampusEngineError("INVALID_STATE", "Finish the upload before reordering files.", 409);
  const pending = all.filter((entry) => entry.status === "READY" && entry.playlistPosition > current.playlistPosition);
  const ids = input.uploadIds;
  if (!Array.isArray(ids) || ids.length !== pending.length || new Set(ids).size !== ids.length || ids.some((id) => !pending.some((entry) => entry.id === id))) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose each queued file once, without moving the active file.", 400);
  }
  const base = current.playlistPosition;
  const stamp = new Date().toISOString();
  await tursoTransaction([
    ...ids.map((id, index) => ({ sql: "UPDATE cinema_uploads SET playlist_position = ?, updated_at = ? WHERE id = ? AND session_id = ? AND status = 'READY'", args: [-(index + 1), stamp, id, input.roomId] })),
    ...ids.map((id, index) => ({ sql: "UPDATE cinema_uploads SET playlist_position = ?, updated_at = ? WHERE id = ? AND session_id = ? AND status = 'READY'", args: [base + index + 1, stamp, id, input.roomId] })),
  ]);
  return { uploads: (await cinemaUploadsForRoom(input.roomId)).filter((entry) => entry.status === "READY").map((entry) => ({ id: entry.id, filename: entry.originalFilename, position: entry.playlistPosition })) };
}

export type CinemaUploadLeaseAccess = {
  upload: CinemaUpload;
  roomStatus: string;
  /** The host counts even if their membership row is somehow missing, as in `roomView`. */
  member: boolean;
};

/**
 * What serving one byte of a playback lease needs: the upload the token names,
 * the room's state and whether the student still holds a seat — one query,
 * because a player asks for many ranges and each one pays for this read.
 *
 * The signature proves the lease was minted for this room, upload and student;
 * it cannot prove any of them is still true. This is the read that makes a
 * removal, a room that ended and a video taken down all take effect at the next
 * request instead of at the end of the lease's twenty minutes.
 */
export async function cinemaUploadLeaseAccess(input: { roomId: string; uploadId: string; studentId: string }): Promise<CinemaUploadLeaseAccess | null> {
  await requireTurso();
  await ensureCinemaUploadTables();
  const row = rowsToObjects(await turso(
    `SELECT u.*, s.status AS room_status, s.host_student_id AS room_host_student_id, COALESCE(p.student_id,'') AS member_id
       FROM cinema_uploads u
       JOIN cinema_sessions s ON s.id = u.session_id
       LEFT JOIN cinema_participants p ON p.session_id = s.id AND p.student_id = ? AND p.left_at = ''
      WHERE u.session_id = ? AND u.id = ? AND u.status = 'READY' AND s.video_id = u.id AND s.status <> 'DELETED'
      LIMIT 1`,
    [String(input.studentId), String(input.roomId), String(input.uploadId)],
  ))[0];
  if (!row) return null;
  const studentId = String(input.studentId);
  return {
    upload: uploadView(row),
    roomStatus: String(row.room_status || ""),
    member: studentId === String(row.room_host_student_id || "") || Boolean(row.member_id),
  };
}

function uploadExtension(contentType: string) {
  if (contentType === "video/quicktime") return ".mov";
  if (contentType === "video/webm") return ".webm";
  return ".mp4";
}

/** `cinema/{session}/video/{upload}/original.mp4`, exactly as §5 documents. */
export function cinemaUploadKey(sessionId: string, uploadId: string, contentType: string) {
  return `cinema/${sessionId}/video/${uploadId}/original${uploadExtension(contentType)}`;
}

/**
 * Starts the next upload in a room. The row is written only after R2 has
 * accepted the multipart upload, so a failure there leaves no half-state for
 * the client to complete.
 */
export async function beginCinemaUpload(input: {
  roomId: string;
  studentId: string;
  filename?: unknown;
  sizeBytes?: unknown;
  contentType?: unknown;
  ownershipConfirmed?: unknown;
  bucket?: CinemaUploadBucket | null;
  now?: number;
}): Promise<{ upload: CinemaUpload; partBytes: number; parts: number }> {
  await requireTurso();
  await ensureCinemaUploadTables();
  if (!await platformSettingEnabled("cinema_uploads_enabled")) {
    throw new CampusEngineError("INVALID_STATE", "Uploads are switched off on this deployment.", 409);
  }
  if (input.ownershipConfirmed !== true) {
    throw new CampusEngineError("VALIDATION_ERROR", "Confirm you have the right to share this video before uploading.", 400);
  }
  await requireUploadRoom(input.roomId, input.studentId);
  // Repeated takedowns cost the account its upload rights, not the room: the
  // room still works with YouTube, and the platform's own account tools are
  // untouched. A room that simply expired is not a strike — only a moderator's
  // removal sets `removed_by`.
  const strikeLimit = Math.max(1, Math.floor(await platformSettingNumber("cinema_upload_takedown_limit")));
  if (await countCinemaUploaderRemovals(String(input.studentId)) >= strikeLimit) {
    throw new CampusEngineError("FORBIDDEN", "Uploading is turned off for this account after repeated takedowns.", 403);
  }

  const contentType = String(input.contentType || "").trim().toLowerCase();
  if (!(CINEMA_UPLOAD_TYPES as readonly string[]).includes(contentType)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Upload an MP4, MOV or WebM file.", 400);
  }
  const sizeBytes = Math.floor(Number(input.sizeBytes) || 0);
  const limits = await cinemaUploadLimits();
  if (sizeBytes <= 0) throw new CampusEngineError("VALIDATION_ERROR", "That file reports no size.", 400);
  if (sizeBytes > limits.maxBytes) {
    throw new CampusEngineError("VALIDATION_ERROR", "That file is larger than this deployment accepts.", 413);
  }
  const parts = cinemaUploadPartCount(sizeBytes);
  if (parts < 1 || parts > CINEMA_UPLOAD_MAX_PARTS) {
    throw new CampusEngineError("VALIDATION_ERROR", "That file cannot be split into parts this uploader can send.", 413);
  }

  const allowance = await snapshotCinemaRoomAllowance(String(input.roomId), String(input.studentId));
  const queued = await cinemaUploadsForRoom(String(input.roomId));
  if (queued.some((entry) => entry.status === "UPLOADING")) {
    throw new CampusEngineError("INVALID_STATE", "Finish or cancel the current upload before adding another file.", 409);
  }
  if (queued.length >= allowance.maxFiles) {
    throw new CampusEngineError("INVALID_STATE", `This room's ${allowance.plan} plan allows ${allowance.maxFiles} file${allowance.maxFiles === 1 ? "" : "s"}.`, 409);
  }
  if (queued.reduce((sum, entry) => sum + entry.fileSizeBytes, 0) + sizeBytes > allowance.maxBytes) {
    throw new CampusEngineError("VALIDATION_ERROR", "The playlist would exceed this room's storage allowance.", 413);
  }

  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket || typeof bucket.createMultipartUpload !== "function") {
    throw new CampusEngineError("CONFIG_REQUIRED", "Uploads need the private bucket binding.", 503);
  }

  const uploadId = crypto.randomUUID();
  const key = cinemaUploadKey(String(input.roomId), uploadId, contentType);
  const multipart = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
  const stamp = new Date(input.now ?? Date.now()).toISOString();
  const retentionHours = Math.max(1, Math.floor(await platformSettingNumber("cinema_retention_hours")));
  const filename = String(input.filename || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 160);
  const positionRow = rowsToObjects(await turso("SELECT COALESCE(MAX(playlist_position),0) AS last_position FROM cinema_uploads WHERE session_id = ?", [String(input.roomId)]))[0];
  const position = Number(positionRow?.last_position || 0) + 1;
  try {
    await turso(
      `INSERT INTO cinema_uploads (id,session_id,uploader_id,r2_object_key,r2_upload_id,original_filename,file_size_bytes,mime_type,duration_seconds,ownership_confirmed,status,expires_at,deleted_at,created_at,updated_at,playlist_position)
       VALUES (?,?,?,?,?,?,?,?,0,1,'UPLOADING',?,'',?,?,?)`,
      [uploadId, String(input.roomId), String(input.studentId), key, String(multipart.uploadId || ""), filename, sizeBytes, contentType,
        new Date((input.now ?? Date.now()) + retentionHours * 3_600_000).toISOString(), stamp, stamp, position],
    );
  } catch (error) {
    await abortMultipart(bucket, key, String(multipart.uploadId || ""));
    throw error;
  }
  logEvent("info", "cinema_upload_started", { roomId: String(input.roomId), uploadId, sizeBytes, contentType, parts });
  await incrementMetric("cinema_uploads_started");
  const created = (await cinemaUploadsForRoom(String(input.roomId))).find((entry) => entry.id === uploadId);
  return {
    upload: created || uploadView({
      id: uploadId, session_id: String(input.roomId), uploader_id: String(input.studentId), r2_object_key: key,
      original_filename: filename, file_size_bytes: sizeBytes, mime_type: contentType, duration_seconds: 0,
      ownership_confirmed: 1, status: "UPLOADING", expires_at: "", deleted_at: "", removed_by: "", removed_reason: "",
      created_at: stamp, updated_at: stamp, playlist_position: position,
    }),
    partBytes: CINEMA_UPLOAD_PART_BYTES,
    parts,
  };
}

/**
 * One part of an in-flight upload. The size of each part is checked against the
 * declared total before R2 sees it, so a client cannot pad the object past what
 * the room agreed to store.
 */
export async function putCinemaUploadPart(input: {
  roomId: string;
  studentId: string;
  partNumber?: unknown;
  body?: ArrayBuffer | null;
  bucket?: CinemaUploadBucket | null;
}): Promise<CinemaUploadPart> {
  await requireTurso();
  await ensureCinemaUploadTables();
  await requireUploadRoom(input.roomId, input.studentId);
  const row = await activeUploadRow(input.roomId);
  const sizeBytes = Number(row.file_size_bytes || 0);
  const parts = cinemaUploadPartCount(sizeBytes);
  const partNumber = Math.floor(Number(input.partNumber) || 0);
  if (partNumber < 1 || partNumber > parts) {
    throw new CampusEngineError("VALIDATION_ERROR", "That is not a part of this upload.", 400);
  }
  const body = input.body;
  if (!body || body.byteLength < 1) throw new CampusEngineError("VALIDATION_ERROR", "That part carried no bytes.", 400);
  const expected = partNumber < parts ? CINEMA_UPLOAD_PART_BYTES : sizeBytes - (parts - 1) * CINEMA_UPLOAD_PART_BYTES;
  if (body.byteLength !== expected) {
    throw new CampusEngineError("VALIDATION_ERROR", "That part is not the size this upload agreed to.", 400);
  }
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket || typeof bucket.resumeMultipartUpload !== "function") {
    throw new CampusEngineError("CONFIG_REQUIRED", "Uploads need the private bucket binding.", 503);
  }
  const multipart = bucket.resumeMultipartUpload(String(row.r2_object_key), String(row.r2_upload_id || ""));
  const stored = await multipart.uploadPart(partNumber, body);
  return { partNumber, etag: String(stored?.etag || "") };
}

/**
 * Finishes the upload. R2's own report of the object is the authority: when the
 * stored size is not the declared one, the object is deleted and the row fails,
 * rather than the room being told to trust a client's count.
 */
export async function completeCinemaUpload(input: {
  roomId: string;
  studentId: string;
  parts?: unknown;
  bucket?: CinemaUploadBucket | null;
}): Promise<{ upload: CinemaUpload; durationSeconds: number }> {
  await requireTurso();
  await ensureCinemaUploadTables();
  await requireUploadRoom(input.roomId, input.studentId);
  const row = await activeUploadRow(input.roomId);
  const uploadId = String(row.id || "");
  const sizeBytes = Number(row.file_size_bytes || 0);
  const key = String(row.r2_object_key || "");
  const expectedParts = cinemaUploadPartCount(sizeBytes);

  const supplied = Array.isArray(input.parts) ? input.parts : [];
  const parts: CinemaUploadPart[] = supplied.map((entry) => {
    const value = (entry || {}) as { partNumber?: unknown; etag?: unknown };
    return { partNumber: Math.floor(Number(value.partNumber) || 0), etag: String(value.etag || "").trim() };
  });
  const numbers = new Set(parts.map((part) => part.partNumber));
  if (parts.length !== expectedParts || numbers.size !== expectedParts
    || parts.some((part) => part.partNumber < 1 || part.partNumber > expectedParts || !part.etag)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Every part of the file has to arrive before it can be finished.", 400);
  }
  parts.sort((left, right) => left.partNumber - right.partNumber);

  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket || typeof bucket.resumeMultipartUpload !== "function") {
    throw new CampusEngineError("CONFIG_REQUIRED", "Uploads need the private bucket binding.", 503);
  }
  const multipart = bucket.resumeMultipartUpload(key, String(row.r2_upload_id || ""));
  const object = await multipart.complete(parts);
  const storedSize = Math.floor(Number(object?.size ?? sizeBytes));
  const stamp = new Date().toISOString();
  if (storedSize !== sizeBytes) {
    try { await bucket.delete(key); } catch { /* the lifecycle rule is the second net */ }
    await turso("UPDATE cinema_uploads SET status = 'FAILED', updated_at = ? WHERE id = ?", [stamp, uploadId]);
    logEvent("warn", "cinema_upload_size_mismatch", { roomId: String(input.roomId), uploadId, declared: sizeBytes, stored: storedSize });
    await incrementMetric("cinema_uploads_failed");
    throw new CampusEngineError("VALIDATION_ERROR", "The file that arrived does not match the size it declared. The room is unchanged.", 400);
  }

  const durationSeconds = await readCinemaUploadDuration(key, bucket);
  const maxMinutes = Math.max(1, Math.floor(await platformSettingNumber("cinema_max_upload_minutes")));
  if (durationSeconds > 0 && durationSeconds > maxMinutes * 60) {
    try { await bucket.delete(key); } catch { /* same net as above */ }
    await turso("UPDATE cinema_uploads SET status = 'FAILED', duration_seconds = ?, updated_at = ? WHERE id = ?", [durationSeconds, stamp, uploadId]);
    logEvent("warn", "cinema_upload_too_long", { roomId: String(input.roomId), uploadId, durationSeconds, maxMinutes });
    await incrementMetric("cinema_uploads_failed");
    throw new CampusEngineError("VALIDATION_ERROR", "That video is longer than this deployment accepts. The room is unchanged.", 413);
  }

  const allowance = await cinemaRoomAllowance(String(input.roomId));
  const queuedMinutes = (await cinemaUploadsForRoom(String(input.roomId)))
    .filter((entry) => entry.id !== uploadId && entry.status === "READY")
    .reduce((sum, entry) => sum + entry.durationSeconds, 0);
  if (durationSeconds > 0 && queuedMinutes + durationSeconds > allowance.maxMinutes * 60) {
    try { await bucket.delete(key); } catch { /* retention retries deletion */ }
    await turso("UPDATE cinema_uploads SET status = 'FAILED', duration_seconds = ?, updated_at = ? WHERE id = ?", [durationSeconds, stamp, uploadId]);
    throw new CampusEngineError("VALIDATION_ERROR", "The playlist would exceed this room's playback allowance.", 413);
  }

  await turso(
    "UPDATE cinema_uploads SET status = 'READY', duration_seconds = ?, updated_at = ? WHERE id = ? AND status = 'UPLOADING'",
    [durationSeconds, stamp, uploadId],
  );
  // Completing a file never changes the host's public or invite-only choice.
  // Playback still requires a signed lease for an active room member.
  const selected = await turso(
    "UPDATE cinema_sessions SET video_source_type = 'UPLOAD', video_id = ?, updated_at = ? WHERE id = ? AND video_id = ''",
    [uploadId, stamp, String(input.roomId)],
  );
  if (Number(selected.affected_row_count || 0) > 0) {
    const room = rowsToObjects(await turso(
      "SELECT host_student_id,title,starts_at,ends_at,duration_minutes,status FROM cinema_sessions WHERE id = ? LIMIT 1",
      [String(input.roomId)],
    ))[0];
    if (room && Number(room.duration_minutes || 0) === 0 && !String(room.ends_at || "")) {
      const scheduledStart = Date.parse(String(room.starts_at || ""));
      const endsAt = new Date(Math.max(Date.now(), Number.isFinite(scheduledStart) ? scheduledStart : 0) + allowance.maxMinutes * 60_000).toISOString();
      await turso("UPDATE cinema_sessions SET ends_at = ?, duration_minutes = ?, updated_at = ? WHERE id = ? AND ends_at = '' AND duration_minutes = 0",
        [endsAt, allowance.maxMinutes, stamp, String(input.roomId)]);
      await scheduleCinemaRoom(String(input.roomId), {
        hostStudentId: String(room.host_student_id || ""), title: String(room.title || ""),
        sourceType: "UPLOAD", videoId: uploadId, startsAt: String(room.starts_at || ""), endsAt,
      });
    }
  }
  // The room's screens learn about the new source on the socket; the row is the
  // record, and a reconnect picks it up from the snapshot as it always did.
  if (Number(selected.affected_row_count || 0) > 0) await announceCinemaSource(String(input.roomId), { sourceType: "UPLOAD", videoId: uploadId });
  logEvent("info", "cinema_upload_ready", { roomId: String(input.roomId), uploadId, sizeBytes, durationSeconds });
  await incrementMetric("cinema_uploads_ready");
  const fresh = (await cinemaUploadsForRoom(String(input.roomId))).find((entry) => entry.id === uploadId);
  return { upload: fresh || uploadView({ ...row, status: "READY", duration_seconds: durationSeconds, updated_at: stamp }), durationSeconds };
}

/** The host gives up on an upload; nothing of it is left to complete. */
export async function abortCinemaUpload(input: {
  roomId: string;
  studentId: string;
  bucket?: CinemaUploadBucket | null;
}): Promise<{ aborted: boolean }> {
  await requireTurso();
  await ensureCinemaUploadTables();
  await requireUploadRoom(input.roomId, input.studentId);
  const row = rowsToObjects(await turso(
    `SELECT ${UPLOAD_COLUMNS} FROM cinema_uploads WHERE session_id = ? AND status = 'UPLOADING' LIMIT 1`,
    [String(input.roomId)],
  ))[0];
  if (!row) return { aborted: false };
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  await abortMultipart(bucket, String(row.r2_object_key || ""), String(row.r2_upload_id || ""));
  if (bucket) { try { await bucket.delete(String(row.r2_object_key || "")); } catch { /* best effort */ } }
  await turso("UPDATE cinema_uploads SET status = 'FAILED', updated_at = ? WHERE id = ? AND status = 'UPLOADING'", [new Date().toISOString(), String(row.id)]);
  logEvent("info", "cinema_upload_aborted", { roomId: String(input.roomId), uploadId: String(row.id) });
  await incrementMetric("cinema_uploads_failed");
  return { aborted: true };
}

async function abortMultipart(bucket: CinemaUploadBucket | null | undefined, key: string, uploadId: string) {
  if (!bucket || !key || !uploadId || typeof bucket.resumeMultipartUpload !== "function") return;
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  } catch (error) {
    logEvent("warn", "cinema_upload_abort_failed", { key, reason: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * How many videos this account has had taken down by a moderator.
 *
 * Retention deletions leave `removed_by` empty, so a room that simply expired
 * is not held against its host. This is the number the upload guard reads and
 * the number a report card shows beside the uploader's name.
 */
export async function countCinemaUploaderRemovals(uploaderId: string, options: { excludeUploadId?: string } = {}) {
  await requireTurso();
  await ensureCinemaUploadTables();
  const row = rowsToObjects(await turso(
    "SELECT COUNT(*) AS removals FROM cinema_uploads WHERE uploader_id = ? AND removed_by <> '' AND id <> ?",
    [String(uploaderId || ""), String(options.excludeUploadId || "")],
  ))[0];
  return Math.max(0, Math.floor(Number(row?.removals || 0)));
}

/**
 * A moderator takes the room's video down, and the room keeps going without it.
 *
 * The order is the one M5 set for messages and M6 for retention: the object
 * goes first, then the row, then the room. The deleted row stops a playback
 * lease from being signed at all — a member's already-issued URL answers 404
 * because the media route re-reads the status on every request. A bucket that
 * refuses leaves the row DELETING and the video unplayable, and the moderator
 * can try again, rather than a row that says DELETED over an object still in
 * the bucket.
 */
export async function takeDownCinemaUpload(input: {
  roomId: string;
  actor: string;
  reason?: unknown;
  bucket?: CinemaUploadBucket | null;
  now?: number;
}) {
  await requireTurso();
  await ensureCinemaUploadTables();
  const roomId = String(input.roomId || "");
  const row = rowsToObjects(await turso(
    `SELECT ${UPLOAD_COLUMNS} FROM cinema_uploads WHERE session_id = ? AND id = (SELECT video_id FROM cinema_sessions WHERE id = ?) LIMIT 1`,
    [roomId, roomId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "This room has no video attached.", 404);
  const upload = uploadView(row);
  if (upload.status === "DELETED") throw new CampusEngineError("INVALID_STATE", "That video has already been removed.", 409);
  const reason = String(input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const stamp = new Date(input.now ?? Date.now()).toISOString();

  if (upload.status !== "DELETING") {
    await turso("UPDATE cinema_uploads SET status = 'DELETING', updated_at = ? WHERE id = ? AND status <> 'DELETED'", [stamp, upload.id]);
  }
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (upload.status === "UPLOADING") await abortMultipart(bucket, upload.objectKey, String(row.r2_upload_id || ""));
  if (bucket) {
    try {
      await bucket.delete([upload.objectKey, `cinema/${roomId}/video/${upload.id}/thumbnail.webp`]);
    } catch (error) {
      logEvent("warn", "cinema_upload_takedown_failed", { roomId, uploadId: upload.id, reason: error instanceof Error ? error.message : "unknown" });
      throw new CampusEngineError("ENGINE_ERROR", "The bucket refused the deletion, so the video is still there. Try again.", 502);
    }
  }
  await turso(
    "UPDATE cinema_uploads SET status = 'DELETED', deleted_at = ?, removed_by = ?, removed_reason = ?, updated_at = ? WHERE id = ? AND status = 'DELETING'",
    [stamp, String(input.actor || ""), reason, stamp, upload.id],
  );
  // The room follows the video. Guarded, so a room that attached a different
  // video between the read and the write is left exactly as it is.
  const next = (await cinemaUploadsForRoom(roomId)).find((entry) => entry.status === "READY" && entry.playlistPosition > upload.playlistPosition);
  const flipped = await turso(
    "UPDATE cinema_sessions SET video_id = ?, updated_at = ? WHERE id = ? AND video_source_type = 'UPLOAD' AND video_id = ?",
    [next?.id || "", stamp, roomId, upload.id],
  );
  if (Number(flipped.affected_row_count || 0) > 0) await announceCinemaSource(roomId, { sourceType: "UPLOAD", videoId: next?.id || "" });
  const uploaderRemovals = await countCinemaUploaderRemovals(upload.uploaderId);
  await consoleAudit({
    actor: input.actor,
    action: "cinema_upload_removed",
    targetType: "cinema_upload",
    targetReference: upload.id,
    details: {
      roomId,
      uploaderId: upload.uploaderId,
      filename: upload.originalFilename,
      sizeBytes: upload.fileSizeBytes,
      reason,
      uploaderRemovals,
    },
  });
  logEvent("info", "cinema_upload_removed", { roomId, uploadId: upload.id, uploaderId: upload.uploaderId, uploaderRemovals, actor: input.actor });
  await incrementMetric("cinema_uploads_removed");
  return {
    id: upload.id,
    roomId,
    uploaderId: upload.uploaderId,
    filename: upload.originalFilename,
    sizeBytes: upload.fileSizeBytes,
    reason,
    removedBy: String(input.actor || ""),
    removedAt: stamp,
    uploaderRemovals,
    roomReset: Number(flipped.affected_row_count || 0) > 0,
  };
}

async function activeUploadRow(roomId: string) {
  const row = rowsToObjects(await turso(
    `SELECT ${UPLOAD_COLUMNS} FROM cinema_uploads WHERE session_id = ? AND status = 'UPLOADING' LIMIT 1`,
    [String(roomId)],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "This room has no upload in flight.", 404);
  if (String(row.status || "") !== "UPLOADING") {
    throw new CampusEngineError("INVALID_STATE", "This upload is no longer accepting parts.", 409);
  }
  return row;
}

/**
 * The retention step, called by the room's cleanup once the room is expired.
 *
 * `retry` means the bucket refused: the caller leaves the room at EXPIRED and
 * the next tick tries again, rather than marking a room deleted while its video
 * is still in the bucket. No binding at all is not a failure — a deployment
 * without R2 has no object to delete.
 */
export async function purgeCinemaUploadForRoom(sessionId: string, options: { bucket?: CinemaUploadBucket | null; now?: number } = {}) {
  await requireTurso();
  await ensureCinemaUploadTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${UPLOAD_COLUMNS} FROM cinema_uploads WHERE session_id = ? AND status <> 'DELETED'`,
    [String(sessionId)],
  ));
  if (!rows.length) return { status: "absent" as const };
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  const bucket = options.bucket === undefined ? await cinemaUploadBucket() : options.bucket;
  for (const row of rows) {
    const id = String(row.id);
    await turso("UPDATE cinema_uploads SET status = 'DELETING', updated_at = ? WHERE id = ? AND status <> 'DELETED'", [stamp, id]);
    if (String(row.status || "") === "UPLOADING") {
      await abortMultipart(bucket, String(row.r2_object_key || ""), String(row.r2_upload_id || ""));
    }
    if (bucket) {
      try { await bucket.delete([String(row.r2_object_key || ""), `cinema/${sessionId}/video/${id}/thumbnail.webp`]); }
      catch (error) {
        logEvent("warn", "cinema_upload_delete_failed", { roomId: String(sessionId), uploadId: id, reason: error instanceof Error ? error.message : "unknown" });
        return { status: "retry" as const };
      }
    }
    await turso("UPDATE cinema_uploads SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'DELETING'", [stamp, stamp, id]);
    logEvent("info", "cinema_upload_deleted", { roomId: String(sessionId), uploadId: id });
    await incrementMetric("cinema_uploads_deleted");
  }
  return { status: "deleted" as const };
}

/** Resolves the binding on demand; a deployment without it gets the 503 above. */
export async function cinemaUploadBucket(): Promise<CinemaUploadBucket | null> {
  return (await privateBucket() as CinemaUploadBucket | undefined) ?? null;
}

/**
 * The length of an MP4 or MOV, read from the `mvhd` atom in the object's head.
 *
 * R2 metadata carries size and type, not length, and nothing here transcodes;
 * this is the one honest way to know the length without believing the uploader.
 * A file whose index sits at the end of the container (no faststart) reports 0,
 * which the docs state as a limitation rather than hiding behind a claim.
 */
export async function readCinemaUploadDuration(key: string, bucket: CinemaUploadBucket): Promise<number> {
  try {
    const head = await bucket.get(key, { range: { offset: 0, length: 262_144 } });
    if (!head?.body) return 0;
    const bytes = new Uint8Array(await new Response(head.body).arrayBuffer());
    return parseMp4Duration(bytes);
  } catch {
    return 0;
  }
}

/** Walks atoms to `moov` and reads `mvhd`; exported because it is worth testing. */
export function parseMp4Duration(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    // size 1 means a 64-bit length follows the type; size 0 means "to the end".
    if (size === 0) break;
    const step = size === 1 ? Number(offset + 16 <= bytes.byteLength ? view.getBigUint64(offset + 8) : 0) : size;
    if (step < 8) break;
    if (type === "moov") {
      const end = Math.min(offset + step, bytes.byteLength);
      let inner = offset + 8;
      while (inner + 8 <= end) {
        const innerSize = view.getUint32(inner);
        const innerType = String.fromCharCode(bytes[inner + 4], bytes[inner + 5], bytes[inner + 6], bytes[inner + 7]);
        if (innerType === "mvhd" && inner + 20 <= end) {
          const version = bytes[inner + 8];
          const timescaleAt = version === 1 ? inner + 8 + 4 + 16 : inner + 8 + 4 + 8;
          const durationAt = timescaleAt + 4;
          if (version === 1) {
            if (durationAt + 8 > end) return 0;
            const timescale = view.getUint32(timescaleAt);
            const duration = Number(view.getBigUint64(durationAt));
            return timescale > 0 ? Math.round(duration / timescale) : 0;
          }
          if (durationAt + 4 > end) return 0;
          const timescale = view.getUint32(timescaleAt);
          const duration = view.getUint32(durationAt);
          return timescale > 0 ? Math.round(duration / timescale) : 0;
        }
        if (innerSize < 8) break;
        inner += innerSize;
      }
      return 0;
    }
    offset += step;
  }
  return 0;
}
