import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { cinemaUploadBucket, cinemaUploadForRoom, type CinemaUpload, type CinemaUploadBucket } from "@/lib/cinema-engine/uploads";
import { envValue } from "@/lib/runtime-env";

/**
 * Playback for uploaded video: a short-lived signed URL, and the bytes behind it.
 *
 * The lease is the authorisation. A student who is a member of an open room asks
 * for a URL, the server checks membership and the request's room status, and the
 * answer is a token that names the room, the upload and the student for twenty
 * minutes. The media route validates that token and streams the object — with
 * byte ranges, because a video element scrubs by asking for ranges — and never
 * exposes the object key.
 *
 * A URL that expires inside a long room is intended: the player asks for a new
 * one when playback stalls, and ending a room stops new leases immediately. An
 * already-issued lease runs out on its own; the docs say so rather than
 * pretending a signed URL can be revoked.
 */

export const CINEMA_MEDIA_URL_TTL_SECONDS = 20 * 60;
/** Domain separation: this key is never the session cookie's key, even by accident. */
const CINEMA_MEDIA_CONTEXT = "cinema-media-v1";

async function mediaSecret() {
  // A deployment that has not set a dedicated secret reuses the student session
  // secret, so Phase 2 needs no new variable; the context string above keeps the
  // two uses from ever producing the same signature.
  const secret = await envValue("CINEMA_MEDIA_SECRET", ["STUDENT_SESSION_SECRET"]);
  if (secret.length < 32) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Cinema playback needs a signing secret of at least 32 characters.", 503);
  }
  return secret;
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlText(text: string) {
  return base64url(new TextEncoder().encode(text));
}

function bytesOfBase64url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function signPayload(payload: string) {
  const secret = await mediaSecret();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${CINEMA_MEDIA_CONTEXT}.${payload}`)));
  return base64url(signature);
}

/** Length-independent comparison, so a wrong token cannot be narrowed by timing. */
function signaturesMatch(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export type CinemaMediaClaims = {
  roomId: string;
  uploadId: string;
  studentId: string;
  expiresAt: number;
};

export async function signCinemaMediaToken(input: {
  roomId: string;
  uploadId: string;
  studentId: string;
  now?: number;
  ttlSeconds?: number;
}) {
  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(60, Math.floor(input.ttlSeconds ?? CINEMA_MEDIA_URL_TTL_SECONDS)) * 1000;
  const payload = base64urlText(JSON.stringify({ r: String(input.roomId), u: String(input.uploadId), s: String(input.studentId), exp: expiresAt }));
  const token = `${payload}.${await signPayload(payload)}`;
  return { token, expiresAt, expiresInSeconds: Math.floor((expiresAt - now) / 1000) };
}

export async function verifyCinemaMediaToken(token: unknown, now = Date.now()): Promise<CinemaMediaClaims | null> {
  const value = String(token || "");
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  if (!supplied || !signaturesMatch(await signPayload(payload), supplied)) return null;
  const bytes = bytesOfBase64url(payload);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { r?: unknown; u?: unknown; s?: unknown; exp?: unknown };
    const roomId = String(parsed.r || "");
    const uploadId = String(parsed.u || "");
    const studentId = String(parsed.s || "");
    const expiresAt = Number(parsed.exp || 0);
    if (!roomId || !uploadId || !studentId || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return { roomId, uploadId, studentId, expiresAt };
  } catch {
    return null;
  }
}

/**
 * The only way a playback URL is born: membership first, then an open room,
 * then a video that is actually READY. A room with no upload answers 404, the
 * same "not yours is not there" rule the rest of Cinema follows.
 */
export async function issueCinemaPlayback(input: { roomId: string; studentId: string }) {
  const room = await readRoom({ id: input.roomId, studentId: input.studentId });
  if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Only someone in the room can play its video.", 403);
  if (room.status !== "CREATED" && room.status !== "LIVE") {
    throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  }
  const upload = await cinemaUploadForRoom(room.id);
  if (!upload || upload.status !== "READY") {
    throw new CampusEngineError("NOT_FOUND", "This room has no video ready to play.", 404);
  }
  const lease = await signCinemaMediaToken({ roomId: room.id, uploadId: upload.id, studentId: input.studentId });
  return {
    url: `/api/cinema/media/${lease.token}`,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    expiresInSeconds: lease.expiresInSeconds,
    upload: {
      id: upload.id,
      mimeType: upload.mimeType,
      sizeBytes: upload.fileSizeBytes,
      durationSeconds: upload.durationSeconds,
      filename: upload.originalFilename,
    },
  };
}

/** A `Range: bytes=start-end` header, resolved against the object's real size. */
export function parseCinemaByteRange(header: unknown, size: number): { offset: number; length: number } | null | "invalid" {
  const value = String(header || "").trim();
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size <= 0) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  let start: number;
  let end: number;
  if (!rawStart) {
    // A suffix range: the last N bytes.
    const suffix = Math.min(Number(rawEnd), size);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = size - suffix;
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { offset: start, length: end - start + 1 };
}

export type CinemaMediaObject = {
  body: ReadableStream;
  contentType: string;
  totalBytes: number;
  offset: number;
  length: number;
  partial: boolean;
};

/**
 * Reads the object, whole or as one range. `null` means the object is gone,
 * which after a retention purge is the truth a player should be told.
 */
export async function readCinemaMediaObject(input: {
  upload: CinemaUpload;
  range?: { offset: number; length: number } | null;
  bucket?: CinemaUploadBucket | null;
}): Promise<CinemaMediaObject | null> {
  const bucket = input.bucket === undefined ? await cinemaUploadBucket() : input.bucket;
  if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Playback needs the private bucket binding.", 503);
  const object = await bucket.get(input.upload.objectKey, input.range ? { range: input.range } : undefined);
  if (!object?.body) return null;
  const totalBytes = Math.max(0, Number(input.upload.fileSizeBytes || 0));
  const offset = input.range?.offset ?? 0;
  const length = input.range?.length ?? totalBytes;
  return {
    body: object.body,
    contentType: input.upload.mimeType || "application/octet-stream",
    totalBytes,
    offset,
    length,
    partial: Boolean(input.range),
  };
}

/** The upload a token names, refused when the room has moved on to another. */
export async function cinemaUploadForToken(claims: CinemaMediaClaims) {
  const upload = await cinemaUploadForRoom(claims.roomId);
  if (!upload || upload.id !== claims.uploadId || upload.status !== "READY") {
    throw new CampusEngineError("NOT_FOUND", "That video is no longer available.", 404);
  }
  return upload;
}
