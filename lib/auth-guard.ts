import { ensureAuthFailuresTable, isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;
const memory = new Map<string, { attempts: number; lockedUntil: number }>();

export type AuthLockStatus = { locked: boolean; retryAfter: number };

function memoryKey(scope: string, subject: string) {
  return `${scope}:${subject}`;
}

function retryAfterSeconds(until: number, now: number) {
  return Math.max(1, Math.ceil((until - now) / 1000));
}

/**
 * Reports whether a scope/subject pair is currently locked out. Backed by
 * Turso when configured, with a per-isolate fallback for local preview.
 */
export async function authGuardStatus(scope: string, subject: string): Promise<AuthLockStatus> {
  const now = Date.now();
  if (!subject) return { locked: false, retryAfter: 0 };
  if (await isTursoConfiguredRuntime()) {
    await ensureAuthFailuresTable();
    const row = rowsToObjects(await turso("SELECT locked_until FROM auth_failures WHERE scope = ? AND subject = ? LIMIT 1", [scope, subject]))[0];
    const until = Date.parse(String(row?.locked_until || ""));
    return Number.isFinite(until) && until > now ? { locked: true, retryAfter: retryAfterSeconds(until, now) } : { locked: false, retryAfter: 0 };
  }
  const local = memory.get(memoryKey(scope, subject));
  return local && local.lockedUntil > now ? { locked: true, retryAfter: retryAfterSeconds(local.lockedUntil, now) } : { locked: false, retryAfter: 0 };
}

/**
 * Records a failed attempt and locks the subject once the threshold is hit.
 */
export async function authGuardFailure(scope: string, subject: string): Promise<AuthLockStatus> {
  const now = Date.now();
  if (!subject) return { locked: false, retryAfter: 0 };
  if (await isTursoConfiguredRuntime()) {
    await ensureAuthFailuresTable();
    const stamp = new Date(now).toISOString();
    await turso(
      "INSERT INTO auth_failures (scope,subject,attempts,locked_until,updated_at) VALUES (?,?,1,'',?) ON CONFLICT(scope,subject) DO UPDATE SET attempts = auth_failures.attempts + 1, updated_at = excluded.updated_at",
      [scope, subject, stamp],
    );
    const attempts = Number(rowsToObjects(await turso("SELECT attempts FROM auth_failures WHERE scope = ? AND subject = ? LIMIT 1", [scope, subject]))[0]?.attempts || 0);
    if (attempts >= MAX_ATTEMPTS) {
      await turso("UPDATE auth_failures SET locked_until = ?, updated_at = ? WHERE scope = ? AND subject = ?", [new Date(now + LOCK_SECONDS * 1000).toISOString(), stamp, scope, subject]);
      return { locked: true, retryAfter: LOCK_SECONDS };
    }
    return { locked: false, retryAfter: 0 };
  }
  const key = memoryKey(scope, subject);
  const entry = memory.get(key) || { attempts: 0, lockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCK_SECONDS * 1000;
  memory.set(key, entry);
  return entry.lockedUntil > now ? { locked: true, retryAfter: retryAfterSeconds(entry.lockedUntil, now) } : { locked: false, retryAfter: 0 };
}

/** Clears the failure counter after a successful attempt. */
export async function authGuardClear(scope: string, subject: string) {
  if (!subject) return;
  memory.delete(memoryKey(scope, subject));
  if (await isTursoConfiguredRuntime()) {
    await ensureAuthFailuresTable();
    await turso("DELETE FROM auth_failures WHERE scope = ? AND subject = ?", [scope, subject]);
  }
}
