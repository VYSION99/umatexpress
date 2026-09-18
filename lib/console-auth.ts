import { CampusEngineError } from "@/lib/campus-engine/errors";
import { hashPassword, verifyPassword } from "@/lib/campus-engine/crypto";
import { envList, envValue } from "@/lib/runtime-env";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * One identity for every console service. Roles decide what an account may do,
 * and the role is always read from the signed session — never from a header,
 * body or query parameter, which a caller can choose freely.
 */
export const CONSOLE_ROLES = ["ADMIN", "MODERATOR", "ORGANIZER", "DRIVER"] as const;
export type ConsoleRole = (typeof CONSOLE_ROLES)[number];

export const CONSOLE_SESSION_COOKIE = "umx_console_session";
const SESSION_SECONDS = 8 * 60 * 60;

export type ConsoleAccount = {
  id: string;
  email: string;
  name: string;
  phone: string;
  role: ConsoleRole;
  status: string;
  profileId: string;
};

type ConsoleSessionPayload = { aid: string; role: ConsoleRole; exp: number; ver: number };

const ACCOUNT_COLUMNS = "id,email,name,COALESCE(phone,'') AS phone,role,status,COALESCE(profile_id,'') AS profile_id";

export function isConsoleRole(value: unknown): value is ConsoleRole {
  return typeof value === "string" && (CONSOLE_ROLES as readonly string[]).includes(value);
}

export function consoleAccountView(row: Record<string, unknown>): ConsoleAccount {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    phone: String(row.phone || ""),
    role: String(row.role) as ConsoleRole,
    status: String(row.status || "PENDING"),
    profileId: String(row.profile_id || ""),
  };
}

let tableReady: Promise<void> | null = null;

/** Memoised per isolate: the console sign-in path must not re-run schema DDL per request. */
export function ensureConsoleAccountsTable() {
  tableReady ??= (async () => {
    await turso(`CREATE TABLE IF NOT EXISTS console_accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT, password_salt TEXT, password_iterations INTEGER,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      profile_id TEXT NOT NULL DEFAULT '',
      token_version INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  })().catch((error) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

async function sessionSecret() {
  const secret = await envValue("CONSOLE_SESSION_SECRET", ["ADMIN_SESSION_SECRET"]);
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
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

function cookieValue(request: Request, name: string) {
  const prefix = `${name}=`;
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

/**
 * The console is expected to be served from its own origin. The host check is
 * defence in depth: the primary control is that every console route requires a
 * session, so an unconfigured host list cannot expose anything on its own.
 */
export async function consoleHosts() {
  return envList("CONSOLE_HOSTS");
}

export async function isConsoleHost(request: Request) {
  const hosts = await consoleHosts();
  if (!hosts.length) return false;
  return hosts.includes(new URL(request.url).host.toLowerCase());
}

async function accountTokenVersion(accountId: string) {
  if (!(await isTursoConfiguredRuntime())) return 0;
  const row = rowsToObjects(await turso("SELECT COALESCE(token_version,0) AS token_version FROM console_accounts WHERE id = ? LIMIT 1", [accountId]))[0];
  return Number(row?.token_version || 0);
}

export async function createConsoleSession(account: Pick<ConsoleAccount, "id" | "role">) {
  const secret = await sessionSecret();
  if (!secret) throw new CampusEngineError("CONFIG_REQUIRED", "CONSOLE_SESSION_SECRET must contain at least 32 characters.", 503);
  const payload = encode(JSON.stringify({
    aid: account.id,
    role: account.role,
    exp: Date.now() + SESSION_SECONDS * 1000,
    ver: await accountTokenVersion(account.id),
  } satisfies ConsoleSessionPayload));
  return `${payload}.${await signature(payload, secret)}`;
}

/**
 * Host-only: no Domain attribute, so the console cookie is never attached to a
 * request for the public booking site.
 */
export async function consoleSessionCookie(account: Pick<ConsoleAccount, "id" | "role">, request: Request) {
  const value = await createConsoleSession(account);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${isSecureRequest(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearConsoleSessionCookie(request: Request) {
  return `${CONSOLE_SESSION_COOKIE}=; Path=/; HttpOnly;${isSecureRequest(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=0`;
}

export async function consoleSessionFromRequest(request: Request): Promise<ConsoleSessionPayload | null> {
  const secret = await sessionSecret();
  const value = cookieValue(request, CONSOLE_SESSION_COOKIE);
  if (!secret || !value) return null;
  try {
    const [payload, suppliedSignature] = value.split(".");
    if (!payload || !suppliedSignature) return null;
    if (!signaturesMatch(await signature(payload, secret), suppliedSignature)) return null;
    const session = JSON.parse(decode(payload)) as ConsoleSessionPayload;
    if (!session.exp || session.exp <= Date.now() || !session.aid || !isConsoleRole(session.role)) return null;
    return session;
  } catch {
    return null;
  }
}

async function storedAccountById(id: string) {
  if (!(await isTursoConfiguredRuntime())) return null;
  await ensureConsoleAccountsTable();
  return rowsToObjects(await turso(`SELECT ${ACCOUNT_COLUMNS} FROM console_accounts WHERE id = ? LIMIT 1`, [id]))[0] || null;
}

/** The signed-in console account, or null. */
export async function consoleAccountFromRequest(request: Request): Promise<ConsoleAccount | null> {
  const session = await consoleSessionFromRequest(request);
  if (!session) return null;
  try {
    const row = await storedAccountById(session.aid);
    if (!row) return null;
    if (String(row.status) !== "ACTIVE") return null;
    // A password change bumps token_version, retiring every older session.
    if (await accountTokenVersion(session.aid) !== session.ver) return null;
    const account = consoleAccountView(row);
    // The stored role wins, so a session minted before a role change cannot
    // keep privileges it no longer has.
    return account.role === session.role ? account : null;
  } catch {
    return null;
  }
}

/** Throws unless the caller holds one of `roles` on a live console session. */
export async function requireConsoleRole(request: Request, roles: readonly ConsoleRole[]): Promise<ConsoleAccount> {
  const account = await consoleAccountFromRequest(request);
  if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to the console to continue.", 401);
  if (!roles.includes(account.role)) throw new CampusEngineError("FORBIDDEN", "Your console role cannot perform this action.", 403);
  return account;
}

export async function verifyConsoleCredentials(emailInput: unknown, password: string) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (!email || !password) return null;
  if (!(await isTursoConfiguredRuntime())) return null;
  await ensureConsoleAccountsTable();
  const row = rowsToObjects(await turso(
    `SELECT ${ACCOUNT_COLUMNS}, password_hash, password_salt, password_iterations FROM console_accounts WHERE lower(email) = ? LIMIT 1`,
    [email],
  ))[0];
  if (!row) return null;
  const ok = await verifyPassword(password, String(row.password_hash || ""), String(row.password_salt || ""), Number(row.password_iterations || 0));
  if (!ok) return null;
  return consoleAccountView(row);
}

export async function createConsoleAccount(input: {
  email?: unknown; password?: unknown; name?: unknown; phone?: unknown; role?: unknown; profileId?: unknown; status?: string;
}) {
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  const name = String(input.name || "").trim();
  if (!email || !name) throw new CampusEngineError("VALIDATION_ERROR", "Name and email are required.", 400);
  if (password.length < 8) throw new CampusEngineError("VALIDATION_ERROR", "Choose a password of at least 8 characters.", 400);
  if (!isConsoleRole(input.role)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid console role.", 400);
  await ensureConsoleAccountsTable();
  const { hash, salt, iterations } = await hashPassword(password);
  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await turso(
    "INSERT INTO console_accounts (id,email,name,phone,password_hash,password_salt,password_iterations,role,status,profile_id,token_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)",
    [id, email, name, String(input.phone || ""), hash, salt, iterations, input.role, input.status || "PENDING", String(input.profileId || ""), stamp, stamp],
  );
  return id;
}

/** Bumps token_version, which retires every live session for that account. */
export async function revokeConsoleSessions(accountId: string) {
  if (!(await isTursoConfiguredRuntime())) return;
  await turso("UPDATE console_accounts SET token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), accountId]);
}

export async function setConsolePassword(accountId: string, password: string) {
  if (password.length < 8) throw new CampusEngineError("VALIDATION_ERROR", "Choose a password of at least 8 characters.", 400);
  await ensureConsoleAccountsTable();
  const { hash, salt, iterations } = await hashPassword(password);
  await turso(
    "UPDATE console_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?",
    [hash, salt, iterations, new Date().toISOString(), accountId],
  );
}
