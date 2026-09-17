import { envValue } from "@/lib/runtime-env";
import { ensureCampusRideTables, getCampusData } from "@/lib/campus-ride";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { hashPassword, validPasswordRecord, verifyPassword } from "@/lib/campus-engine/crypto";

const COOKIE_NAME = "umx_driver_session";
const SESSION_SECONDS = 12 * 60 * 60;
export const DEFAULT_DRIVER_PASSWORD = "Driver@12345";

type DriverSessionPayload = { driverId: string; exp: number; ver: number };

function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function driverSessionSecret() {
  const secret = await envValue("DRIVER_SESSION_SECRET", ["ADMIN_SESSION_SECRET"]);
  if (secret.length < 32 || secret.startsWith("replace-with")) return null;
  return secret;
}

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encode(String.fromCharCode(...new Uint8Array(result)));
}

function signaturesMatch(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index++) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

async function driverTokenVersion(driverId: string) {
  if (!(await isTursoConfiguredRuntime())) return 0;
  const row = rowsToObjects(await turso("SELECT COALESCE(token_version,0) AS token_version FROM campus_drivers WHERE id = ? LIMIT 1", [driverId]))[0];
  return Number(row?.token_version || 0);
}

function cookieValue(request: Request) {
  const prefix = `${COOKIE_NAME}=`;
  const item = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(prefix.length)); } catch { return null; }
}

function isSecureRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === "https:"
    || request.headers.get("x-forwarded-proto") === "https"
    || Boolean(request.headers.get("cf-visitor")?.includes("https"));
}

export async function createDriverSession(driverId: string) {
  const secret = await driverSessionSecret();
  if (!secret) throw new CampusEngineError("CONFIG_REQUIRED", "DRIVER_SESSION_SECRET or ADMIN_SESSION_SECRET must contain at least 32 characters.", 503);
  const payload = encode(JSON.stringify({ driverId, exp: Date.now() + SESSION_SECONDS * 1000, ver: await driverTokenVersion(driverId) } satisfies DriverSessionPayload));
  return `${payload}.${await signature(payload, secret)}`;
}

export async function driverSessionCookie(driverId: string, request: Request) {
  const value = await createDriverSession(driverId);
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly;${isSecureRequest(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearDriverSessionCookie(request: Request) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${isSecureRequest(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=0`;
}

export async function driverSessionFromRequest(request: Request): Promise<{ driverId: string; version: number } | null> {
  const secret = await driverSessionSecret();
  const value = cookieValue(request);
  if (!secret || !value) return null;
  try {
    const [payload, suppliedSignature] = value.split(".");
    if (!payload || !suppliedSignature) return null;
    if (!signaturesMatch(await signature(payload, secret), suppliedSignature)) return null;
    const session = JSON.parse(decode(payload)) as DriverSessionPayload;
    if (!session.exp || session.exp <= Date.now() || !session.driverId) return null;
    return { driverId: session.driverId, version: Number(session.ver || 0) };
  } catch {
    return null;
  }
}

export async function requireDriver(request: Request) {
  const session = await driverSessionFromRequest(request);
  if (!session) throw new CampusEngineError("UNAUTHORIZED", "Driver access is not authorised.", 401);
  const data = await getCampusData();
  const driver = data.drivers.find((item) => item.id === session.driverId);
  if (!driver || !driver.active) throw new CampusEngineError("FORBIDDEN", "This driver account is inactive.", 403);
  if (Number(driver.tokenVersion || 0) !== session.version) throw new CampusEngineError("UNAUTHORIZED", "Your session has ended. Sign in again.", 401);
  return driver;
}

export async function ensureDriverPassword(driverId: string, password = DEFAULT_DRIVER_PASSWORD) {
  if (!(await isTursoConfiguredRuntime())) return;
  await ensureCampusRideTables();
  const existing = rowsToObjects(await turso("SELECT password_hash,password_salt,password_iterations FROM campus_drivers WHERE id = ? LIMIT 1", [driverId]))[0];
  if (existing && validPasswordRecord(existing.password_hash, existing.password_salt, existing.password_iterations)) return;
  const hashed = await hashPassword(password);
  await turso("UPDATE campus_drivers SET password_hash = ?, password_salt = ?, password_iterations = ?, password_reset_required = 1, updated_at = ? WHERE id = ?", [hashed.hash, hashed.salt, hashed.iterations, new Date().toISOString(), driverId]);
}

function assertStrongDriverPassword(password: string) {
  if (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Use at least 10 characters with uppercase, lowercase, a number, and a symbol.", 400);
  }
  if (password === DEFAULT_DRIVER_PASSWORD) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose a password different from the temporary driver password.", 400);
  }
}

async function storeDriverPassword(driverId: string, password: string, resetRequired: boolean) {
  const hashed = await hashPassword(password);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE campus_drivers SET password_hash = ?, password_salt = ?, password_iterations = ?, password_reset_required = ?, password_changed_at = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?",
    [hashed.hash, hashed.salt, hashed.iterations, resetRequired ? 1 : 0, resetRequired ? "" : stamp, stamp, driverId],
  );
}

export async function changeDriverPassword(request: Request, input: { currentPassword?: string; newPassword?: string }) {
  const session = await driverSessionFromRequest(request);
  if (!session) throw new CampusEngineError("UNAUTHORIZED", "Driver access is not authorised.", 401);
  const driverId = session.driverId;
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before changing driver passwords.", 503);
  const currentPassword = String(input.currentPassword || "");
  const newPassword = String(input.newPassword || "");
  assertStrongDriverPassword(newPassword);
  await ensureCampusRideTables();
  const row = rowsToObjects(await turso("SELECT password_hash,password_salt,password_iterations,COALESCE(token_version,0) AS token_version FROM campus_drivers WHERE id = ? AND active = 1 LIMIT 1", [driverId]))[0];
  if (!row || Number(row.token_version || 0) !== session.version || !await verifyPassword(currentPassword, String(row.password_hash || ""), String(row.password_salt || ""), Number(row.password_iterations || 100000))) {
    throw new CampusEngineError("UNAUTHORIZED", "The current driver password is incorrect.", 401);
  }
  await storeDriverPassword(driverId, newPassword, false);
  return { changed: true, mustChangePassword: false, driverId };
}

export async function resetDriverPasswordByAdmin(driverId: string, password = DEFAULT_DRIVER_PASSWORD) {
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before resetting driver passwords.", 503);
  await ensureCampusRideTables();
  const existing = rowsToObjects(await turso("SELECT id FROM campus_drivers WHERE id = ? LIMIT 1", [driverId]))[0];
  if (!existing) throw new CampusEngineError("NOT_FOUND", "Driver was not found.", 404);
  await storeDriverPassword(driverId, password, true);
  return { driverId, temporaryPassword: password, mustChangePassword: true };
}

export async function verifyDriverCredentials(identifier: string, password: string) {
  const login = identifier.trim().toLowerCase();
  if (!login || !password) throw new CampusEngineError("VALIDATION_ERROR", "Driver phone/email and password are required.", 400);

  if (!(await isTursoConfiguredRuntime())) {
    const data = await getCampusData();
    const driver = data.drivers.find((item) => item.email.toLowerCase() === login || item.phone === identifier.trim());
    if (driver && password === DEFAULT_DRIVER_PASSWORD) return driver;
    return null;
  }

  await ensureCampusRideTables();
  const row = rowsToObjects(await turso(
    "SELECT id,name,phone,COALESCE(email,'') AS email,COALESCE(vehicle_id,'') AS vehicle_id,COALESCE(current_zone_id,'') AS current_zone_id,active,COALESCE(last_seen_at,'') AS last_seen_at,password_hash,password_salt,password_iterations,COALESCE(password_reset_required,1) AS password_reset_required,COALESCE(password_changed_at,'') AS password_changed_at FROM campus_drivers WHERE lower(email) = ? OR phone = ? LIMIT 1",
    [login, identifier.trim()],
  ))[0];
  if (!row || Number(row.active) !== 1) return null;
  if (!validPasswordRecord(row.password_hash, row.password_salt, row.password_iterations)) {
    if (password !== DEFAULT_DRIVER_PASSWORD) return null;
    await ensureDriverPassword(String(row.id));
  }
  const fresh = rowsToObjects(await turso("SELECT password_hash,password_salt,password_iterations FROM campus_drivers WHERE id = ? LIMIT 1", [String(row.id)]))[0];
  const ok = await verifyPassword(password, String(fresh.password_hash), String(fresh.password_salt), Number(fresh.password_iterations || 100000));
  if (!ok) return null;
  return { id:String(row.id), name:String(row.name), phone:String(row.phone), email:String(row.email || ""), vehicleId:String(row.vehicle_id || ""), currentZoneId:String(row.current_zone_id || ""), active:true, lastSeenAt:String(row.last_seen_at || ""), mustChangePassword:Number(row.password_reset_required) === 1, passwordChangedAt:String(row.password_changed_at || "") };
}
