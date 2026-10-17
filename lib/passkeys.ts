import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertAuthScopeHost } from "@/lib/auth-scope-host";
import { consoleAccountFromRequest, consoleAccountView, consoleDelegateRecord, type ConsoleRole } from "@/lib/console-auth";
import { resolveConsoleSignIn } from "@/lib/console-signin";
import { studentAccountFromRequest, studentAccountView, verifyStudentCredentials } from "@/lib/student-auth";
import { rowsToObjects, turso } from "@/lib/turso";

export type PasskeyScope = "STUDENT" | "CONSOLE";
type Account = { id: string; email: string; name: string; role?: ConsoleRole };
type ChallengeRow = { id: string; scope: string; account_id: string; challenge: string; origin: string; rp_id: string; expires_at: string; used_at: string };
type CredentialRow = { id: string; scope: string; account_id: string; rp_id: string; public_key: string; counter: number; transports: string; created_at: string; last_used_at: string };

let ready: Promise<void> | null = null;
function ensureTables() {
  ready ??= (async () => {
    await turso(`CREATE TABLE IF NOT EXISTS auth_passkeys (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, account_id TEXT NOT NULL,
      rp_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL DEFAULT ''
    )`);
    await turso("CREATE INDEX IF NOT EXISTS idx_auth_passkeys_account ON auth_passkeys(scope,account_id)");
    await turso(`CREATE TABLE IF NOT EXISTS auth_passkey_challenges (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '',
      challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT NOT NULL DEFAULT ''
    )`);
    await turso("CREATE INDEX IF NOT EXISTS idx_auth_passkey_challenges_expiry ON auth_passkey_challenges(expires_at)");
  })().catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytes(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function relyingParty(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new CampusEngineError("FORBIDDEN", "Passkeys require HTTPS or localhost.", 403);
  }
  return { origin: url.origin, rpID: url.hostname };
}

async function enrolledAccount(request: Request, scope: PasskeyScope): Promise<Account> {
  await assertAuthScopeHost(request, scope);
  if (scope === "STUDENT") {
    const account = await studentAccountFromRequest(request);
    if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in before adding a passkey.", 401);
    if (!account.emailVerified) throw new CampusEngineError("FORBIDDEN", "Verify your email before adding a passkey.", 403);
    return account;
  }
  const account = await consoleAccountFromRequest(request);
  if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to the console before adding a passkey.", 401);
  if (account.mustChangePassword) throw new CampusEngineError("FORBIDDEN", "Change your temporary password first.", 403);
  return account;
}

async function confirmPassword(scope: PasskeyScope, account: Account, password: string) {
  if (scope === "STUDENT") {
    const verified = await verifyStudentCredentials(account.email, password);
    if (verified?.id === account.id) return;
  } else {
    const verified = await resolveConsoleSignIn(account.email, password);
    if (verified?.account.id === account.id && !verified.mustChangePassword && !verified.bridged) return;
    if (verified?.account.id === account.id && verified.bridged) {
      throw new CampusEngineError("FORBIDDEN", "Set a console password before adding a passkey.", 403);
    }
  }
  throw new CampusEngineError("UNAUTHORIZED", "Confirm your current password to add a passkey.", 401);
}

async function saveChallenge(scope: PasskeyScope, accountId: string, challenge: string, origin: string, rpID: string) {
  await ensureTables();
  const id = crypto.randomUUID();
  await turso("INSERT INTO auth_passkey_challenges (id,scope,account_id,challenge,origin,rp_id,expires_at) VALUES (?,?,?,?,?,?,?)", [
    id, scope, accountId, challenge, origin, rpID, new Date(Date.now() + 5 * 60_000).toISOString(),
  ]);
  return id;
}

async function takeChallenge(id: string, scope: PasskeyScope, accountId: string, origin: string, rpID: string) {
  await ensureTables();
  const result = await turso("UPDATE auth_passkey_challenges SET used_at=? WHERE id=? AND scope=? AND account_id=? AND origin=? AND rp_id=? AND used_at='' AND expires_at>?", [
    new Date().toISOString(), id, scope, accountId, origin, rpID, new Date().toISOString(),
  ]);
  if (result.affected_row_count !== 1) throw new CampusEngineError("UNAUTHORIZED", "This passkey request expired. Try again.", 401);
  const row = rowsToObjects(await turso("SELECT * FROM auth_passkey_challenges WHERE id=?", [id]))[0] as ChallengeRow | undefined;
  if (!row) throw new CampusEngineError("UNAUTHORIZED", "This passkey request expired. Try again.", 401);
  return row;
}

export async function listPasskeys(request: Request, scope: PasskeyScope) {
  const account = await enrolledAccount(request, scope);
  await ensureTables();
  return rowsToObjects(await turso("SELECT id,created_at,last_used_at FROM auth_passkeys WHERE scope=? AND account_id=? ORDER BY created_at DESC", [scope, account.id]));
}

export async function beginPasskeyRegistration(request: Request, scope: PasskeyScope, password: string) {
  const account = await enrolledAccount(request, scope);
  await confirmPassword(scope, account, password);
  const { origin, rpID } = relyingParty(request);
  await ensureTables();
  const existing = rowsToObjects(await turso("SELECT id,transports FROM auth_passkeys WHERE scope=? AND account_id=? AND rp_id=?", [scope, account.id, rpID])) as CredentialRow[];
  const options = await generateRegistrationOptions({
    rpName: scope === "CONSOLE" ? "UMATeXPRESS Console" : "UMATeXPRESS",
    rpID, userName: account.email, userDisplayName: account.name || account.email,
    userID: new TextEncoder().encode(`${scope}:${account.id}`),
    attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: existing.map(row => ({ id: row.id, transports: JSON.parse(row.transports) as string[] })),
  });
  return { options, challengeId: await saveChallenge(scope, account.id, options.challenge, origin, rpID) };
}

export async function finishPasskeyRegistration(request: Request, scope: PasskeyScope, challengeId: string, response: RegistrationResponseJSON) {
  const account = await enrolledAccount(request, scope);
  const { origin, rpID } = relyingParty(request);
  const challenge = await takeChallenge(challengeId, scope, account.id, origin, rpID);
  const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  if (!result.verified) throw new CampusEngineError("UNAUTHORIZED", "The passkey could not be verified.", 401);
  const credential = result.registrationInfo.credential;
  await turso("INSERT INTO auth_passkeys (id,scope,account_id,rp_id,public_key,counter,transports,created_at) VALUES (?,?,?,?,?,?,?,?)", [
    credential.id, scope, account.id, rpID, base64url(credential.publicKey), credential.counter,
    JSON.stringify(credential.transports || []), new Date().toISOString(),
  ]);
  return { registered: true };
}

export async function beginPasskeySignIn(request: Request, scope: PasskeyScope) {
  await assertAuthScopeHost(request, scope);
  const { origin, rpID } = relyingParty(request);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  return { options, challengeId: await saveChallenge(scope, "", options.challenge, origin, rpID) };
}

export async function finishPasskeySignIn(request: Request, scope: PasskeyScope, challengeId: string, response: AuthenticationResponseJSON) {
  await assertAuthScopeHost(request, scope);
  const { origin, rpID } = relyingParty(request);
  const challenge = await takeChallenge(challengeId, scope, "", origin, rpID);
  const row = rowsToObjects(await turso("SELECT * FROM auth_passkeys WHERE id=? AND scope=? AND rp_id=? LIMIT 1", [response.id, scope, rpID]))[0] as CredentialRow | undefined;
  if (!row) throw new CampusEngineError("UNAUTHORIZED", "That passkey is not registered for this account.", 401);
  const verified = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID,
    requireUserVerification: true,
    credential: { id: row.id, publicKey: bytes(row.public_key), counter: Number(row.counter), transports: JSON.parse(row.transports) as string[] },
  });
  if (!verified.verified) throw new CampusEngineError("UNAUTHORIZED", "The passkey could not be verified.", 401);
  const accountRow = rowsToObjects(await turso(
    scope === "STUDENT"
      ? "SELECT id,email,name,phone,created_at,last_login_at,email_verified,verification_required,active FROM student_accounts WHERE id=? LIMIT 1"
      : "SELECT id,email,name,phone,role,status,profile_id,password_hash FROM console_accounts WHERE id=? LIMIT 1",
    [row.account_id],
  ))[0];
  if (!accountRow || (scope === "STUDENT" && (Number(accountRow.active) !== 1 || Number(accountRow.email_verified) !== 1))
    || (scope === "CONSOLE" && (accountRow.status !== "ACTIVE" || !accountRow.password_hash))) {
    throw new CampusEngineError("UNAUTHORIZED", "This account cannot sign in with a passkey.", 401);
  }
  if (scope === "CONSOLE" && accountRow.role === "ADMIN_DELEGATE") {
    const delegate = await consoleDelegateRecord(String(accountRow.id));
    if (!delegate || delegate.mustChangePassword) throw new CampusEngineError("UNAUTHORIZED", "This account cannot sign in with a passkey.", 401);
  }
  const updated = await turso("UPDATE auth_passkeys SET counter=?,last_used_at=? WHERE id=? AND scope=? AND counter=?", [verified.authenticationInfo.newCounter, new Date().toISOString(), row.id, scope, Number(row.counter)]);
  if (updated.affected_row_count !== 1) throw new CampusEngineError("UNAUTHORIZED", "This passkey was already used. Try again.", 401);
  return scope === "STUDENT" ? studentAccountView(accountRow) : consoleAccountView(accountRow);
}

export async function removePasskey(request: Request, scope: PasskeyScope, id: string, password: string) {
  const account = await enrolledAccount(request, scope);
  await confirmPassword(scope, account, password);
  await ensureTables();
  const result = await turso("DELETE FROM auth_passkeys WHERE id=? AND scope=? AND account_id=?", [id, scope, account.id]);
  if (result.affected_row_count !== 1) throw new CampusEngineError("NOT_FOUND", "Passkey not found.", 404);
  await turso(scope === "STUDENT"
    ? "UPDATE student_accounts SET token_version=COALESCE(token_version,0)+1 WHERE id=?"
    : "UPDATE console_accounts SET token_version=COALESCE(token_version,0)+1 WHERE id=?", [account.id]);
  return { removed: true, accountId: account.id, ...(scope === "CONSOLE" ? { role: account.role } : {}) };
}
