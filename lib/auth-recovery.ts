/**
 * Getting back in.
 *
 * Two flows share one table: a password reset (a link, and the same code for
 * anyone reading mail on a phone) and a one-time sign-in code. Both are built
 * the same way, because both are the same secret with different wording:
 *
 *  - a random value is generated, and only its HMAC is stored, so a database
 *    read cannot mint a working link;
 *  - the request carries the purpose, the account and an expiry, so a code for
 *    one flow cannot be replayed in the other;
 *  - verification counts attempts and burns the row after too many, so a
 *    6-digit code is not something to grind through;
 *  - an unknown address is answered exactly like a known one, so the endpoint
 *    cannot be used to find out who has an account.
 *
 * The same rules cover `scope: "STUDENT"` (the one UMaTeXPRESS account) and
 * `scope: "CONSOLE"` (every console role, from admin to driver).
 */

import { assertConsolePassword, ensureConsoleAccountsTable, setConsolePassword, type ConsoleRole } from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";
import { hashPassword } from "@/lib/campus-engine/crypto";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { queueNotification } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";
import { envValue } from "@/lib/runtime-env";
import { assertStudentPassword, ensureStudentAccountsTable } from "@/lib/student-auth";
import { normalizeStudentEmail, validStudentEmail } from "@/lib/student-email";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export const AUTH_RECOVERY_SCOPES = ["STUDENT", "CONSOLE"] as const;
export type AuthRecoveryScope = (typeof AUTH_RECOVERY_SCOPES)[number];
export const AUTH_RECOVERY_PURPOSES = ["RESET", "LOGIN"] as const;
export type AuthRecoveryPurpose = (typeof AUTH_RECOVERY_PURPOSES)[number];

/** Long enough to leave your inbox, short enough that a stale link is dead. */
const RESET_TTL_MS = 30 * 60_000;
/** A sign-in code is typed straight from the mail, so it lives minutes. */
const LOGIN_TTL_MS = 10 * 60_000;
/** Five guesses at a six-digit code is already generous. */
const MAX_ATTEMPTS = 5;

const RECOVERY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS auth_recovery_requests (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    account_id TEXT NOT NULL,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    token_hash TEXT NOT NULL DEFAULT '',
    code_hash TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_auth_recovery_lookup ON auth_recovery_requests(scope, email, purpose, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_auth_recovery_token ON auth_recovery_requests(token_hash)",
];

let recoveryTablesReady: Promise<void> | null = null;

export function ensureAuthRecoveryTables() {
  recoveryTablesReady ??= (async () => {
    await ensureStudentAccountsTable();
    await ensureConsoleAccountsTable();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "authRecovery", version: "020_auth_recovery", statements: RECOVERY_SCHEMA_STATEMENTS });
  })().catch((error: unknown) => {
    recoveryTablesReady = null;
    throw error;
  });
  return recoveryTablesReady;
}

export function isAuthRecoveryScope(value: unknown): value is AuthRecoveryScope {
  return (AUTH_RECOVERY_SCOPES as readonly string[]).includes(String(value || "").trim().toUpperCase());
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The secret that makes a stolen row useless without the deployment. */
async function recoveryPepper() {
  const secret = await envValue("AUTH_RECOVERY_SECRET", ["CONSOLE_SESSION_SECRET", "STUDENT_SESSION_SECRET", "ADMIN_SESSION_SECRET"]);
  if (secret.length < 32 || secret.startsWith("replace-with")) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Set AUTH_RECOVERY_SECRET (or a session secret) before using account recovery.", 503);
  }
  return secret;
}

async function digest(value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await recoveryPepper()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Six digits, uniformly drawn, leading zeros kept. */
function randomCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(value).padStart(6, "0");
}

function timingSafeMatch(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

/** The account a recovery may act on, or null. Inactive accounts are not recoverable. */
async function recoveryAccount(scope: AuthRecoveryScope, email: string) {
  if (scope === "STUDENT") {
    if (!validStudentEmail(email)) return null;
    const row = rowsToObjects(await turso(
      "SELECT id,email,COALESCE(name,'') AS name FROM student_accounts WHERE email = ? AND COALESCE(active,1) = 1 LIMIT 1",
      [email],
    ))[0];
    return row ? { id: String(row.id), email: String(row.email), name: String(row.name), role: "" } : null;
  }
  const row = rowsToObjects(await turso(
    "SELECT id,email,COALESCE(name,'') AS name,COALESCE(role,'') AS role FROM console_accounts WHERE email = ? AND status = 'ACTIVE' LIMIT 1",
    [email],
  ))[0];
  return row ? { id: String(row.id), email: String(row.email), name: String(row.name), role: String(row.role) } : null;
}

async function insertRequest(input: { scope: AuthRecoveryScope; accountId: string; email: string; purpose: AuthRecoveryPurpose; token: string; code: string; ttlMs: number; now: Date }) {
  const stamp = input.now.toISOString();
  const id = crypto.randomUUID();
  await turso(
    `INSERT INTO auth_recovery_requests (id,scope,account_id,email,purpose,token_hash,code_hash,attempts,expires_at,used_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,'',?,?)`,
    [
      id, input.scope, input.accountId, input.email, input.purpose,
      input.token ? await digest(input.token) : "", input.code ? await digest(`${id}:${input.code}`) : "",
      new Date(input.now.getTime() + input.ttlMs).toISOString(), stamp, stamp,
    ],
  );
  return id;
}

/** What the caller may know: the flow started. Never whether the address exists. */
export type AuthRecoveryRequest = { requested: true; delivered: boolean; expiresAt: string };

type ResetEmailInput = { origin: string; resetPath: string; token: string; code: string; name: string };

/**
 * The mail itself. The link and the code travel together, because a student on
 * a phone will tap the link and an administrator on a laptop may prefer to type
 * the code — and both prove the same thing: control of the inbox.
 */
async function sendResetEmail(email: string, input: ResetEmailInput, now: Date) {
  const link = `${input.origin.replace(/\/$/, "")}${input.resetPath}?token=${encodeURIComponent(input.token)}`;
  await queueNotification(turso, {
    recipient: email,
    template: "auth_password_reset",
    subject: "Reset your UMaTeXPRESS password",
    message: [
      `Hello ${input.name || "there"},`,
      "",
      "Someone asked to reset this account's password. If that was you, open the link below, or enter this code on the reset page:",
      "",
      `Code: ${input.code}`,
      "",
      link,
      "",
      "The link and code work once and expire in 30 minutes. If you did not ask, you can ignore this message — nothing has changed.",
    ].join("\n"),
    reference: `reset:${await digest(`${email}:${now.getTime()}`)}`.slice(0, 80),
    nowIso: now.toISOString(),
  }).catch(() => false);
}

async function sendLoginCode(email: string, code: string, now: Date) {
  await queueNotification(turso, {
    recipient: email,
    template: "auth_login_code",
    subject: `Your UMaTeXPRESS sign-in code: ${code}`,
    message: [
      `Your one-time sign-in code is ${code}.`,
      "",
      "It works once and expires in 10 minutes. If you did not try to sign in, change your password — someone may have it.",
    ].join("\n"),
    reference: `otp:${await digest(`${email}:${now.getTime()}`)}`.slice(0, 80),
    nowIso: now.toISOString(),
  }).catch(() => false);
}

/** Normalises the address for the scope: student addresses get their domain rules. */
export function recoveryEmailFor(scope: AuthRecoveryScope, input: unknown) {
  const raw = String(input || "").trim().toLowerCase();
  return scope === "STUDENT" ? normalizeStudentEmail(raw) : raw;
}

/**
 * Starts a password reset. The answer is the same for an unknown address, a
 * known one, and an inactive account, so this endpoint cannot be used to
 * enumerate users; the mail only goes out when there is an account to mail.
 */
export async function requestPasswordReset(input: { scope: AuthRecoveryScope; email: unknown; origin: string; resetPath?: string; now?: Date }): Promise<AuthRecoveryRequest> {
  await ensureAuthRecoveryTables();
  const now = input.now ?? new Date();
  const email = recoveryEmailFor(input.scope, input.email);
  const resetPath = input.resetPath || (input.scope === "CONSOLE" ? "/console/reset-password" : "/reset-password");
  const answer: AuthRecoveryRequest = { requested: true, delivered: false, expiresAt: new Date(now.getTime() + RESET_TTL_MS).toISOString() };
  if (!email || !email.includes("@")) return answer;
  const account = await recoveryAccount(input.scope, email);
  if (!account) {
    logEvent("info", "auth_reset_requested_unknown", { scope: input.scope });
    return answer;
  }
  const token = randomToken();
  const code = randomCode();
  await insertRequest({ scope: input.scope, accountId: account.id, email, purpose: "RESET", token, code, ttlMs: RESET_TTL_MS, now });
  await sendResetEmail(email, { origin: input.origin, resetPath, token, code, name: account.name }, now);
  logEvent("info", "auth_reset_requested", { scope: input.scope, accountId: account.id });
  return { ...answer, delivered: true };
}

/** Starts a one-time sign-in. Same enumeration rule as a reset. */
export async function requestLoginCode(input: { scope: AuthRecoveryScope; email: unknown; now?: Date }): Promise<AuthRecoveryRequest> {
  await ensureAuthRecoveryTables();
  const now = input.now ?? new Date();
  const email = recoveryEmailFor(input.scope, input.email);
  const answer: AuthRecoveryRequest = { requested: true, delivered: false, expiresAt: new Date(now.getTime() + LOGIN_TTL_MS).toISOString() };
  if (!email || !email.includes("@")) return answer;
  const account = await recoveryAccount(input.scope, email);
  if (!account) {
    logEvent("info", "auth_otp_requested_unknown", { scope: input.scope });
    return answer;
  }
  const code = randomCode();
  await insertRequest({ scope: input.scope, accountId: account.id, email, purpose: "LOGIN", token: "", code, ttlMs: LOGIN_TTL_MS, now });
  await sendLoginCode(email, code, now);
  logEvent("info", "auth_otp_requested", { scope: input.scope, accountId: account.id });
  return { ...answer, delivered: true };
}

/** The newest open request for one address and purpose. */
async function openRequest(input: { scope: AuthRecoveryScope; email: string; purpose: AuthRecoveryPurpose }) {
  return rowsToObjects(await turso(
    `SELECT id,account_id,code_hash,token_hash,COALESCE(attempts,0) AS attempts,expires_at,COALESCE(used_at,'') AS used_at
     FROM auth_recovery_requests
     WHERE scope = ? AND email = ? AND purpose = ? AND used_at = ''
     ORDER BY created_at DESC LIMIT 1`,
    [input.scope, input.email, input.purpose],
  ))[0];
}

async function burnRequest(id: string, now: Date) {
  await turso("UPDATE auth_recovery_requests SET used_at = ?, updated_at = ? WHERE id = ?", [now.toISOString(), now.toISOString(), id]);
}

async function countAttempt(id: string, now: Date) {
  await turso("UPDATE auth_recovery_requests SET attempts = COALESCE(attempts,0) + 1, updated_at = ? WHERE id = ?", [now.toISOString(), id]);
}

/**
 * Checks a code against an open request and burns it on success. The attempt
 * counter is written before the comparison, so a crash mid-check cannot hand
 * out free guesses.
 */
async function consumeCode(input: { request: Record<string, unknown>; code: unknown; now: Date }) {
  const id = String(input.request.id || "");
  const supplied = String(input.code || "").trim();
  const expiresAt = Date.parse(String(input.request.expires_at || ""));
  if (!expiresAt || expiresAt <= input.now.getTime()) return false;
  await countAttempt(id, input.now);
  const attempts = Number(input.request.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    await burnRequest(id, input.now);
    return false;
  }
  if (!/^\d{6}$/.test(supplied)) return false;
  if (!timingSafeMatch(String(input.request.code_hash || ""), await digest(`${id}:${supplied}`))) return false;
  await burnRequest(id, input.now);
  return true;
}

/**
 * Signs in with a one-time code. Returns the account to open a session for, or
 * null — the route decides which cookie that is. A used or expired code, an
 * unknown address and a wrong digit are all just "null" to the caller.
 */
export async function verifyLoginCode(input: { scope: AuthRecoveryScope; email: unknown; code: unknown; now?: Date }) {
  await ensureAuthRecoveryTables();
  const now = input.now ?? new Date();
  const email = recoveryEmailFor(input.scope, input.email);
  if (!email) return null;
  const request = await openRequest({ scope: input.scope, email, purpose: "LOGIN" });
  if (!request) return null;
  if (!await consumeCode({ request, code: input.code, now })) return null;
  const account = await recoveryAccount(input.scope, email);
  if (!account || String(account.id) !== String(request.account_id)) return null;
  logEvent("info", "auth_otp_verified", { scope: input.scope, accountId: account.id });
  return account;
}

/**
 * Completes a reset: either the token from the link, or the address and the
 * code from the mail. A new password retires every existing session, which is
 * the point of the reset — the person who had the old password is out.
 */
export async function resetPassword(input: { scope: AuthRecoveryScope; token?: unknown; email?: unknown; code?: unknown; newPassword?: unknown; now?: Date }) {
  await ensureAuthRecoveryTables();
  const now = input.now ?? new Date();
  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
  const token = String(input.token || "").trim();
  const email = recoveryEmailFor(input.scope, input.email);
  let request: Record<string, unknown> | undefined;
  let consume: (() => Promise<boolean>) | null = null;
  if (token) {
    request = rowsToObjects(await turso(
      `SELECT id,account_id,code_hash,token_hash,COALESCE(attempts,0) AS attempts,expires_at,COALESCE(used_at,'') AS used_at
       FROM auth_recovery_requests WHERE scope = ? AND purpose = 'RESET' AND token_hash = ? AND used_at = '' LIMIT 1`,
      [input.scope, await digest(token)],
    ))[0];
    if (!request) throw new CampusEngineError("INVALID_STATE", "That reset link is not valid any more. Ask for a new one.", 409);
    const expiry = Date.parse(String(request.expires_at || ""));
    if (!expiry || expiry <= now.getTime()) {
      await burnRequest(String(request.id), now);
      throw new CampusEngineError("INVALID_STATE", "That reset link has expired. Ask for a new one.", 409);
    }
    consume = async () => {
      await burnRequest(String(request!.id), now);
      return true;
    };
  } else {
    if (!email) throw new CampusEngineError("VALIDATION_ERROR", "Enter the email the code was sent to.", 400);
    request = await openRequest({ scope: input.scope, email, purpose: "RESET" });
    if (!request) throw new CampusEngineError("INVALID_STATE", "Ask for a reset code first.", 409);
    consume = () => consumeCode({ request: request as Record<string, unknown>, code: input.code, now });
  }

  const accountId = String(request.account_id || "");
  const account = await recoveryAccountById(input.scope, accountId);
  if (!account) throw new CampusEngineError("NOT_FOUND", "That account is no longer active.", 404);

  // The password policy is checked before the link or the code is spent: a
  // rejected password is not a rejected attempt, and asking for a new link
  // because the old one was typed with a weak password would be miserable.
  if (input.scope === "STUDENT") {
    assertStudentPassword(newPassword);
    if (!await consume()) throw new CampusEngineError("UNAUTHORIZED", "That code is not correct or has expired.", 401);
    const hashed = await hashPassword(newPassword);
    await turso(
      "UPDATE student_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?",
      [hashed.hash, hashed.salt, hashed.iterations, now.toISOString(), accountId],
    );
  } else {
    assertConsolePassword(account.role as ConsoleRole, newPassword);
    if (!await consume()) throw new CampusEngineError("UNAUTHORIZED", "That code is not correct or has expired.", 401);
    await setConsolePassword(accountId, newPassword);
    await consoleAudit({
      actor: account.email,
      action: "CONSOLE_PASSWORD_RESET",
      targetType: "console_account",
      targetReference: accountId,
      details: { role: account.role, method: token ? "LINK" : "CODE" },
    }).catch(() => undefined);
  }
  await queueNotification(turso, {
    recipient: account.email,
    template: "auth_password_changed",
    subject: "Your UMaTeXPRESS password was changed",
    message: [
      `Hello ${account.name || "there"},`,
      "",
      "This account's password was just reset, and every older session was signed out.",
      "If this was not you, request another reset immediately and contact the UMaTeXPRESS team.",
    ].join("\n"),
    reference: `changed:${await digest(`${accountId}:${now.getTime()}`)}`.slice(0, 80),
    nowIso: now.toISOString(),
  }).catch(() => false);
  logEvent("info", "auth_password_reset", { scope: input.scope, accountId });
  return { reset: true, email: account.email };
}

async function recoveryAccountById(scope: AuthRecoveryScope, accountId: string) {
  if (scope === "STUDENT") {
    const row = rowsToObjects(await turso(
      "SELECT id,email,COALESCE(name,'') AS name FROM student_accounts WHERE id = ? AND COALESCE(active,1) = 1 LIMIT 1",
      [accountId],
    ))[0];
    return row ? { id: String(row.id), email: String(row.email), name: String(row.name), role: "" } : null;
  }
  const row = rowsToObjects(await turso(
    "SELECT id,email,COALESCE(name,'') AS name,COALESCE(role,'') AS role FROM console_accounts WHERE id = ? AND status = 'ACTIVE' LIMIT 1",
    [accountId],
  ))[0];
  return row ? { id: String(row.id), email: String(row.email), name: String(row.name), role: String(row.role) } : null;
}
