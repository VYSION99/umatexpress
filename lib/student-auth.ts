/**
 * UMaTeXPRESS student accounts.
 *
 * One account covers the whole platform: campusRide and vacationRide both check
 * this same session, so a student signs in once and can book either service.
 * Browsing is never gated — only creating a booking or starting a payment is.
 *
 * Only UMaT student addresses are accepted (`@st.umat.edu.gh`). No email
 * provider is configured on this deployment, so an account is an email plus a
 * password rather than a magic link, and `email_verified` stays 0 until a
 * delivery channel exists to prove the address.
 *
 * Nothing here ever returns a password hash, salt or iteration count.
 */

import { hashPassword, validPasswordRecord, verifyPassword, bytesToBase64 } from "@/lib/campus-engine/crypto";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { envValue } from "@/lib/runtime-env";
import { STUDENT_EMAIL_DOMAIN, normalizeStudentEmail, validStudentEmail } from "@/lib/student-email";
import { hasColumn, isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

export const STUDENT_SESSION_COOKIE = "umx_student_session";
/** Long enough that a student is not asked to sign in mid-semester. */
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MIN_PASSWORD_LENGTH = 10;

export type StudentAccount = {
  id: string;
  email: string;
  name: string;
  phone: string;
  createdAt: string;
  lastLoginAt: string;
};

type StudentSessionPayload = { sid: string; exp: number; ver: number };

export { STUDENT_EMAIL_DOMAIN, normalizeStudentEmail, validStudentEmail };

export function assertStudentEmail(email: string) {
  if (!validStudentEmail(email)) {
    throw new CampusEngineError("VALIDATION_ERROR", `Use your UMaT student email ending in @${STUDENT_EMAIL_DOMAIN}.`, 400);
  }
}

export function assertStudentPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Use at least 10 characters with uppercase, lowercase, a number, and a symbol.", 400);
  }
}

export function studentAccountView(row: Record<string, unknown>): StudentAccount {
  return {
    id: String(row.id || ""),
    email: String(row.email || ""),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    createdAt: String(row.created_at || ""),
    lastLoginAt: String(row.last_login_at || ""),
  };
}

/** The readable projection: everything except the credential columns. */
const ACCOUNT_COLUMNS = "id,email,COALESCE(name,'') AS name,COALESCE(phone,'') AS phone,COALESCE(created_at,'') AS created_at,COALESCE(last_login_at,'') AS last_login_at";

let studentAccountsTable: Promise<void> | null = null;

/**
 * Self-heals the schema for previews and for databases that were migrated before
 * this table existed. sql/000_umatexpress_full_migration.sql is the source of truth.
 *
 * The check is four statements, and on a hosted database each one is a network
 * round trip, so the answer is remembered for the life of the isolate rather than
 * paid again on every sign-in. A failure is forgotten instead of cached, so a
 * database that is briefly unreachable is retried on the next request.
 */
export function ensureStudentAccountsTable() {
  if (!studentAccountsTable) {
    studentAccountsTable = createStudentAccountsTable().catch((error: unknown) => {
      studentAccountsTable = null;
      throw error;
    });
  }
  return studentAccountsTable;
}

async function createStudentAccountsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS student_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  )`);
  if (!(await hasColumn("student_accounts", "token_version"))) {
    await turso("ALTER TABLE student_accounts ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!(await hasColumn("student_accounts", "email_verified"))) {
    await turso("ALTER TABLE student_accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!(await hasColumn("student_accounts", "active"))) {
    await turso("ALTER TABLE student_accounts ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
}

async function requireTurso() {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "UMaTeXPRESS accounts are not configured. Configure Turso before accepting sign-ups.", 503);
  }
  await ensureStudentAccountsTable();
}

async function storedAccount(email: string) {
  if (!(await isTursoConfiguredRuntime())) return null;
  await ensureStudentAccountsTable();
  return rowsToObjects(await turso(
    "SELECT id,email,name,phone,password_hash,password_salt,password_iterations,COALESCE(token_version,0) AS token_version,COALESCE(active,1) AS active FROM student_accounts WHERE email = ? LIMIT 1",
    [email],
  ))[0] || null;
}

async function sessionSecret() {
  const secret = await envValue("STUDENT_SESSION_SECRET", ["DRIVER_SESSION_SECRET", "ADMIN_SESSION_SECRET"]);
  if (secret.length < 32 || secret.startsWith("replace-with")) return null;
  return secret;
}

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

async function accountTokenVersion(accountId: string) {
  if (!(await isTursoConfiguredRuntime())) return 0;
  const row = rowsToObjects(await turso("SELECT COALESCE(token_version,0) AS token_version FROM student_accounts WHERE id = ? LIMIT 1", [accountId]))[0];
  return Number(row?.token_version || 0);
}

function cookieValue(request: Request) {
  const prefix = `${STUDENT_SESSION_COOKIE}=`;
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

export async function createStudentSession(accountId: string) {
  const secret = await sessionSecret();
  if (!secret) throw new CampusEngineError("CONFIG_REQUIRED", "STUDENT_SESSION_SECRET must contain at least 32 characters.", 503);
  const payload = encode(JSON.stringify({ sid: accountId, exp: Date.now() + SESSION_SECONDS * 1000, ver: await accountTokenVersion(accountId) } satisfies StudentSessionPayload));
  return `${payload}.${await signature(payload, secret)}`;
}

export async function studentSessionCookie(accountId: string, request: Request) {
  const value = await createStudentSession(accountId);
  return `${STUDENT_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${isSecureRequest(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearStudentSessionCookie(request: Request) {
  return `${STUDENT_SESSION_COOKIE}=; Path=/; HttpOnly;${isSecureRequest(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=0`;
}

export async function studentSessionFromRequest(request: Request): Promise<{ accountId: string; version: number } | null> {
  const secret = await sessionSecret();
  const value = cookieValue(request);
  if (!secret || !value) return null;
  try {
    const [payload, suppliedSignature] = value.split(".");
    if (!payload || !suppliedSignature) return null;
    if (!signaturesMatch(await signature(payload, secret), suppliedSignature)) return null;
    const session = JSON.parse(decode(payload)) as StudentSessionPayload;
    if (!session.exp || session.exp <= Date.now() || !session.sid) return null;
    return { accountId: session.sid, version: Number(session.ver || 0) };
  } catch {
    return null;
  }
}

async function accountFromSession(session: { accountId: string; version: number }) {
  const row = await storedAccountById(session.accountId);
  if (!row || Number(row.active) !== 1) return null;
  // A password change bumps token_version, which retires every older session.
  if (Number(row.token_version || 0) !== session.version) return null;
  return studentAccountView(row);
}

async function storedAccountById(id: string) {
  if (!(await isTursoConfiguredRuntime())) return null;
  await ensureStudentAccountsTable();
  return rowsToObjects(await turso(
    `SELECT ${ACCOUNT_COLUMNS}, COALESCE(token_version,0) AS token_version, COALESCE(active,1) AS active, password_hash, password_salt, password_iterations FROM student_accounts WHERE id = ? LIMIT 1`,
    [id],
  ))[0] || null;
}

/** The signed-in account, or null. Never throws, so browsing stays open. */
export async function studentAccountFromRequest(request: Request): Promise<StudentAccount | null> {
  const session = await studentSessionFromRequest(request);
  if (!session) return null;
  try { return await accountFromSession(session); }
  catch { return null; }
}

/** For the booking/payment routes: a student session is required to spend money. */
export async function requireStudent(request: Request): Promise<StudentAccount> {
  const session = await studentSessionFromRequest(request);
  const account = session ? await accountFromSession(session) : null;
  if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to your UMaTeXPRESS account to continue.", 401);
  return account;
}

export async function registerStudent(input: { email?: unknown; password?: unknown; name?: unknown; phone?: unknown }) {
  const email = normalizeStudentEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  const phone = typeof input.phone === "string" ? input.phone.trim().slice(0, 30) : "";
  assertStudentEmail(email);
  assertStudentPassword(password);
  await requireTurso();
  if (await storedAccount(email)) {
    throw new CampusEngineError("CONFLICT", "An account already exists for that email. Sign in instead.", 409);
  }
  const hashed = await hashPassword(password);
  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await turso(
      "INSERT INTO student_accounts (id,email,name,phone,password_hash,password_salt,password_iterations,created_at,updated_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [id, email, name, phone, hashed.hash, hashed.salt, hashed.iterations, stamp, stamp, stamp],
    );
  } catch {
    // The unique index is the real guard: two sign-ups cannot both win the email.
    throw new CampusEngineError("CONFLICT", "An account already exists for that email. Sign in instead.", 409);
  }
  const row = await storedAccountById(id);
  return row ? studentAccountView(row) : { id, email, name, phone, createdAt: stamp, lastLoginAt: stamp };
}

/**
 * Returns the account, or null for every failure mode. Unknown emails still pay
 * one password derivation so the response time does not reveal which addresses
 * have accounts.
 */
export async function verifyStudentCredentials(emailInput: unknown, password: string) {
  const email = normalizeStudentEmail(emailInput);
  const row = validStudentEmail(email) ? await storedAccount(email) : null;
  if (!row || Number(row.active) !== 1 || !validPasswordRecord(row.password_hash, row.password_salt, row.password_iterations)) {
    await verifyPassword(password, bytesToBase64(new Uint8Array(32)), bytesToBase64(new Uint8Array(16)));
    return null;
  }
  if (!await verifyPassword(password, String(row.password_hash), String(row.password_salt), Number(row.password_iterations))) return null;
  await turso("UPDATE student_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?", [new Date().toISOString(), new Date().toISOString(), String(row.id)]);
  return studentAccountView(row);
}

export async function updateStudentProfile(request: Request, input: { name?: unknown; phone?: unknown }) {
  const account = await requireStudent(request);
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : account.name;
  const phone = typeof input.phone === "string" ? input.phone.trim().slice(0, 30) : account.phone;
  await turso("UPDATE student_accounts SET name = ?, phone = ?, updated_at = ? WHERE id = ?", [name, phone, new Date().toISOString(), account.id]);
  return { ...account, name, phone };
}

export async function changeStudentPassword(request: Request, input: { currentPassword?: unknown; newPassword?: unknown }) {
  const session = await studentSessionFromRequest(request);
  if (!session) throw new CampusEngineError("UNAUTHORIZED", "Sign in to your UMaTeXPRESS account to continue.", 401);
  const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
  assertStudentPassword(newPassword);
  await requireTurso();
  const row = await storedAccountById(session.accountId);
  if (!row || !await verifyPassword(currentPassword, String(row.password_hash), String(row.password_salt), Number(row.password_iterations || 100000))) {
    throw new CampusEngineError("UNAUTHORIZED", "The current password is incorrect.", 401);
  }
  const hashed = await hashPassword(newPassword);
  await turso(
    "UPDATE student_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?",
    [hashed.hash, hashed.salt, hashed.iterations, new Date().toISOString(), session.accountId],
  );
  return { changed: true, accountId: session.accountId };
}
