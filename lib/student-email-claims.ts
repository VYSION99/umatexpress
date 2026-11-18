import { CampusEngineError } from "@/lib/campus-engine/errors";
import { queueNotification } from "@/lib/notifications";
import { envValue } from "@/lib/runtime-env";
import { normalizeStudentEmail, validStudentEmail } from "@/lib/student-email";
import { ensureNotificationsTable, rowsToObjects, turso } from "@/lib/turso";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

const readyByUrl = new Map<string, Promise<void>>();

/** A student address can be linked to one account after its inbox is proved. */
export async function ensureStudentEmailClaimsTable() {
  const url = (await envValue("TURSO_DATABASE_URL")) || "default";
  let ready = readyByUrl.get(url);
  if (!ready) {
    ready = (async () => {
      await turso(`CREATE TABLE IF NOT EXISTS student_email_claims (
        account_id TEXT PRIMARY KEY,
        student_email TEXT NOT NULL,
        code_hash TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`);
      await turso("CREATE UNIQUE INDEX IF NOT EXISTS idx_student_email_claims_verified ON student_email_claims(student_email) WHERE verified_at <> ''");
      // The two address columns live in different tables; these triggers keep a
      // verified student address from being assigned to two accounts in a race.
      await turso(`CREATE TRIGGER IF NOT EXISTS student_email_claim_primary_guard
        BEFORE UPDATE OF verified_at ON student_email_claims
        WHEN NEW.verified_at <> '' AND EXISTS (
          SELECT 1 FROM student_accounts WHERE email = NEW.student_email AND id <> NEW.account_id
        ) BEGIN SELECT RAISE(ABORT, 'student email already belongs to an account'); END`);
      await turso(`CREATE TRIGGER IF NOT EXISTS student_account_claim_guard
        BEFORE INSERT ON student_accounts
        WHEN EXISTS (
          SELECT 1 FROM student_email_claims WHERE student_email = NEW.email AND verified_at <> '' AND account_id <> NEW.id
        ) BEGIN SELECT RAISE(ABORT, 'student email already linked to an account'); END`);
    })().catch((error: unknown) => { readyByUrl.delete(url); throw error; });
    readyByUrl.set(url, ready);
  }
  return ready;
}

type ClaimRow = { account_id: string; student_email: string; expires_at: string; attempts: number; verified_at: string };

async function claimFor(accountId: string): Promise<ClaimRow | null> {
  await ensureStudentEmailClaimsTable();
  return (rowsToObjects(await turso(
    "SELECT account_id,student_email,expires_at,attempts,verified_at FROM student_email_claims WHERE account_id=? LIMIT 1",
    [accountId],
  ))[0] as ClaimRow | undefined) || null;
}

export async function studentEmailClaim(accountId: string) {
  const row = await claimFor(accountId);
  return row ? { studentEmail: row.student_email, verified: Boolean(row.verified_at), expiresAt: row.verified_at ? "" : row.expires_at } : { studentEmail: "", verified: false, expiresAt: "" };
}

export async function hasVerifiedStudentEmail(accountId: string) {
  const claim = await studentEmailClaim(accountId);
  return claim.verified && validStudentEmail(claim.studentEmail);
}

async function codeDigest(accountId: string, email: string, code: string) {
  const secret = await envValue("AUTH_RECOVERY_SECRET", ["STUDENT_SESSION_SECRET", "ADMIN_SESSION_SECRET"]);
  if (secret.length < 32 || secret.startsWith("replace-with")) throw new CampusEngineError("CONFIG_REQUIRED", "Account verification is not configured.", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${accountId}:${email}:${code}`)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function emailBelongsToOtherAccount(accountId: string, email: string) {
  const row = rowsToObjects(await turso("SELECT id FROM student_accounts WHERE email=? AND id<>? LIMIT 1", [email, accountId]))[0];
  return Boolean(row);
}

export async function requestStudentEmailClaim(accountId: string, input: unknown) {
  const email = normalizeStudentEmail(input);
  if (!validStudentEmail(email)) throw new CampusEngineError("VALIDATION_ERROR", "Enter a UMaT student email ending in @st.umat.edu.gh.", 400);
  await ensureStudentEmailClaimsTable();
  const current = await claimFor(accountId);
  if (current?.verified_at) throw new CampusEngineError("CONFLICT", "A student email is already verified for this account.", 409);
  if (await emailBelongsToOtherAccount(accountId, email)) throw new CampusEngineError("CONFLICT", "This student email is already linked to an account.", 409);
  const existing = rowsToObjects(await turso("SELECT account_id FROM student_email_claims WHERE student_email=? AND verified_at<>'' AND account_id<>? LIMIT 1", [email, accountId]))[0];
  if (existing) throw new CampusEngineError("CONFLICT", "This student email is already linked to an account.", 409);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const hash = await codeDigest(accountId, email, code);
  const pending = await turso(`INSERT INTO student_email_claims (account_id,student_email,code_hash,expires_at,attempts,verified_at,updated_at)
    VALUES (?,?,?,?,0,'',?) ON CONFLICT(account_id) DO UPDATE SET student_email=excluded.student_email,
    code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,verified_at='',updated_at=excluded.updated_at
    WHERE student_email_claims.verified_at=''`,
  [accountId, email, hash, expiresAt, now.toISOString()]);
  if (pending.affected_row_count !== 1) throw new CampusEngineError("CONFLICT", "A student email is already verified for this account.", 409);
  await ensureNotificationsTable();
  await queueNotification(turso, {
    recipient: email,
    template: "auth_student_email_verification",
    subject: "Verify your UMaT student email",
    message: `Your UMaTeXPRESS student verification code is ${code}.\n\nIt expires in 10 minutes. If you did not request this, you can ignore this message.`,
    reference: `student-email:${accountId}:${crypto.randomUUID()}`,
    nowIso: now.toISOString(),
    sensitive: true,
    expiresAt,
  });
  return { studentEmail: email, verified: false, expiresAt };
}

export async function verifyStudentEmailClaim(accountId: string, input: unknown) {
  const code = String(input || "").trim();
  if (!/^\d{6}$/.test(code)) throw new CampusEngineError("VALIDATION_ERROR", "Enter the six-digit code.", 400);
  const row = await claimFor(accountId);
  if (!row || row.verified_at || Date.parse(row.expires_at) <= Date.now()) throw new CampusEngineError("UNAUTHORIZED", "That code is incorrect or expired. Request a new one.", 401);
  if (await emailBelongsToOtherAccount(accountId, row.student_email)) throw new CampusEngineError("CONFLICT", "This student email is already linked to an account.", 409);
  const now = new Date().toISOString();
  const attempt = await turso("UPDATE student_email_claims SET attempts=attempts+1,updated_at=? WHERE account_id=? AND verified_at='' AND expires_at>? AND attempts<?", [now, accountId, now, MAX_ATTEMPTS]);
  if (attempt.affected_row_count !== 1) throw new CampusEngineError("UNAUTHORIZED", "That code is incorrect or expired. Request a new one.", 401);
  const hash = await codeDigest(accountId, row.student_email, code);
  try {
    const confirmed = await turso("UPDATE student_email_claims SET verified_at=?,code_hash='',expires_at='',updated_at=? WHERE account_id=? AND code_hash=? AND verified_at='' AND attempts<=?", [now, now, accountId, hash, MAX_ATTEMPTS]);
    if (confirmed.affected_row_count !== 1) throw new CampusEngineError("UNAUTHORIZED", "That code is incorrect or expired. Request a new one.", 401);
  } catch (error) {
    if (error instanceof CampusEngineError) throw error;
    throw new CampusEngineError("CONFLICT", "This student email is already linked to an account.", 409);
  }
  return { studentEmail: row.student_email, verified: true, expiresAt: "" };
}
