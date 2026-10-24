import { imagesBinding, privateBucket } from "@/lib/cloudflare-bindings";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAccountFromRequest } from "@/lib/console-auth";
import { studentAccountFromRequest } from "@/lib/student-auth";
import { rowsToObjects, turso } from "@/lib/turso";

export type ProfileScope = "STUDENT" | "CONSOLE";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
let tableReady: Promise<void> | null = null;

function ensureTable() {
  if (!tableReady) tableReady = turso(`CREATE TABLE IF NOT EXISTS account_profile_photos (
    scope TEXT NOT NULL CHECK (scope IN ('STUDENT', 'CONSOLE')),
    account_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, account_id)
  )`).then(() => undefined).catch(error => { tableReady = null; throw error; });
  return tableReady;
}

export function profileScope(value: unknown): ProfileScope {
  if (value === "STUDENT" || value === "CONSOLE") return value;
  throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid account type.", 400);
}

async function accountId(request: Request, scope: ProfileScope) {
  const account = scope === "STUDENT" ? await studentAccountFromRequest(request) : await consoleAccountFromRequest(request);
  if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to manage your profile photo.", 401);
  return account.id;
}

function validImage(bytes: Uint8Array, type: string) {
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const webp = bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return type === "image/jpeg" && jpeg || type === "image/png" && png || type === "image/webp" && webp;
}

export async function readProfilePhoto(request: Request, scope: ProfileScope) {
  const id = await accountId(request, scope);
  await ensureTable();
  const row = rowsToObjects(await turso("SELECT object_key,content_type,updated_at FROM account_profile_photos WHERE scope=? AND account_id=?", [scope, id]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "No profile photo is set.", 404);
  const bucket = await privateBucket();
  if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Profile photo storage is unavailable.", 503);
  const object = await bucket.get(String(row.object_key)) as { body?: ReadableStream } | null;
  if (!object?.body) throw new CampusEngineError("NOT_FOUND", "The profile photo could not be found.", 404);
  return { body: object.body, type: String(row.content_type), updatedAt: String(row.updated_at) };
}

export async function saveProfilePhoto(request: Request, scope: ProfileScope, body: ArrayBuffer, type: string) {
  const id = await accountId(request, scope);
  if (!body.byteLength || body.byteLength > MAX_UPLOAD_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo smaller than 4 MB.", 413);
  if (!validImage(new Uint8Array(body), type)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid JPG, PNG, or WebP photo.", 400);
  const bucket = await privateBucket();
  if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Profile photo storage is unavailable.", 503);
  let processed: ArrayBuffer;
  try {
    const images = await imagesBinding();
    if (!images) throw new Error("Image transformation is unavailable.");
    const image = await images.input(new Blob([body], { type }).stream())
      .transform({ width: 320, height: 320, fit: "cover" }).output({ format: "image/webp", quality: 82 });
    processed = await image.response().arrayBuffer();
  } catch {
    // The editor already crops to a bounded WebP. Keep photo uploads usable
    // when the optional Images service is unavailable on this account.
    if (type !== "image/webp" || body.byteLength > 512 * 1024) {
      throw new CampusEngineError("VALIDATION_ERROR", "This image could not be processed. Try another photo.", 400);
    }
    processed = body;
  }
  if (!processed.byteLength || processed.byteLength > 512 * 1024) throw new CampusEngineError("VALIDATION_ERROR", "This photo is too complex. Try a simpler image.", 400);
  await ensureTable();
  const previous = rowsToObjects(await turso("SELECT object_key FROM account_profile_photos WHERE scope=? AND account_id=?", [scope, id]))[0];
  const key = `accounts/${scope.toLowerCase()}/${id}/avatar-${crypto.randomUUID()}.webp`;
  await bucket.put(key, processed, { httpMetadata: { contentType: "image/webp" } });
  try {
    const updatedAt = new Date().toISOString();
    await turso(`INSERT INTO account_profile_photos (scope,account_id,object_key,content_type,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope,account_id) DO UPDATE SET object_key=excluded.object_key,content_type=excluded.content_type,updated_at=excluded.updated_at`, [scope, id, key, "image/webp", updatedAt]);
    if (previous?.object_key) await bucket.delete(String(previous.object_key)).catch(() => undefined);
    return updatedAt;
  } catch (error) {
    await bucket.delete(key).catch(() => undefined);
    throw error;
  }
}

export async function removeProfilePhoto(request: Request, scope: ProfileScope) {
  const id = await accountId(request, scope);
  await ensureTable();
  const row = rowsToObjects(await turso("SELECT object_key FROM account_profile_photos WHERE scope=? AND account_id=?", [scope, id]))[0];
  if (!row) return;
  await turso("DELETE FROM account_profile_photos WHERE scope=? AND account_id=?", [scope, id]);
  const bucket = await privateBucket();
  if (bucket) await bucket.delete(String(row.object_key)).catch(() => undefined);
}
