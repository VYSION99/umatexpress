import { CampusEngineError } from "@/lib/campus-engine/errors";
import { hashPassword } from "@/lib/campus-engine/crypto";
import { assertConsolePassword, DELEGATABLE_SERVICES, ensureConsoleDelegatesTable } from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

/** Only these operational services can be delegated. Account administration stays with the owner. */

export type AdminDelegate = {
  id: string; name: string; email: string; status: string; services: string[];
  mustChangePassword: boolean; createdAt: string; updatedAt: string;
};

function serviceGrants(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.some((value) => typeof value !== "string" || !(DELEGATABLE_SERVICES as readonly string[]).includes(value))) {
    throw new CampusEngineError("VALIDATION_ERROR", "Select at least one supported console service.", 400);
  }
  return [...new Set(input as string[])];
}

function delegateView(row: Record<string, unknown>): AdminDelegate {
  let services: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.services || "[]"));
    if (Array.isArray(parsed)) services = parsed.filter((service): service is string => typeof service === "string" && (DELEGATABLE_SERVICES as readonly string[]).includes(service));
  } catch { /* Corrupt grants fail closed. */ }
  return {
    id: String(row.id), name: String(row.name), email: String(row.email), status: String(row.status), services,
    mustChangePassword: Number(row.must_change_password) === 1,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function listAdminDelegates(): Promise<AdminDelegate[]> {
  await ensureConsoleDelegatesTable();
  return rowsToObjects(await turso(`SELECT a.id,a.name,a.email,a.status,d.services,d.must_change_password,d.created_at,d.updated_at
    FROM console_admin_delegates d JOIN console_accounts a ON a.id=d.account_id
    WHERE a.role='ADMIN_DELEGATE' ORDER BY d.created_at DESC`)).map(delegateView);
}

export async function createAdminDelegate(input: {
  name?: unknown; email?: unknown; password?: unknown; services?: unknown; actor: string;
}): Promise<AdminDelegate> {
  const name = String(input.name || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  const services = serviceGrants(input.services);
  if (name.length < 2 || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter a valid name and email address.", 400);
  }
  assertConsolePassword("ADMIN", password);
  await ensureConsoleDelegatesTable();
  const existing = rowsToObjects(await turso("SELECT id FROM console_accounts WHERE email=? LIMIT 1", [email]))[0];
  if (existing) throw new CampusEngineError("CONFLICT", "That email already belongs to a console account.", 409);
  const { hash, salt, iterations } = await hashPassword(password);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await tursoTransaction([
      { sql: "INSERT INTO console_accounts (id,email,name,phone,password_hash,password_salt,password_iterations,role,status,profile_id,token_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)", args: [id,email,name,"",hash,salt,iterations,"ADMIN_DELEGATE","ACTIVE","",now,now] },
      { sql: "INSERT INTO console_admin_delegates (account_id,services,must_change_password,created_by,created_at,updated_at) VALUES (?,?,1,?,?,?)", args: [id,JSON.stringify(services),input.actor,now,now] },
    ]);
  } catch (error) {
    if (error instanceof Error && /unique constraint/i.test(error.message)) throw new CampusEngineError("CONFLICT", "That email already belongs to a console account.", 409);
    throw error;
  }
  await consoleAudit({ actor: input.actor, action: "CONSOLE_DELEGATE_CREATED", targetType: "console_account", targetReference: id, details: { email, services } }).catch(() => undefined);
  return { id, name, email, status: "ACTIVE", services, mustChangePassword: true, createdAt: now, updatedAt: now };
}

export async function updateAdminDelegate(input: {
  id?: unknown; status?: unknown; services?: unknown; actor: string; actorId: string;
}): Promise<AdminDelegate> {
  const id = String(input.id || "").trim();
  if (!id || id === input.actorId) throw new CampusEngineError("VALIDATION_ERROR", "Choose another delegate account.", 400);
  const status = String(input.status || "").trim().toUpperCase();
  if (status !== "ACTIVE" && status !== "SUSPENDED") throw new CampusEngineError("VALIDATION_ERROR", "Choose active or suspended status.", 400);
  const services = serviceGrants(input.services);
  await ensureConsoleDelegatesTable();
  const existing = rowsToObjects(await turso("SELECT a.id FROM console_admin_delegates d JOIN console_accounts a ON a.id=d.account_id WHERE a.id=? AND a.role='ADMIN_DELEGATE' LIMIT 1", [id]))[0];
  if (!existing) throw new CampusEngineError("NOT_FOUND", "Delegate account not found.", 404);
  const now = new Date().toISOString();
  await tursoTransaction([
    { sql: "UPDATE console_admin_delegates SET services=?,updated_at=? WHERE account_id=?", args: [JSON.stringify(services),now,id] },
    { sql: "UPDATE console_accounts SET status=?,token_version=COALESCE(token_version,0)+1,updated_at=? WHERE id=? AND role='ADMIN_DELEGATE'", args: [status,now,id] },
  ]);
  await consoleAudit({ actor: input.actor, action: "CONSOLE_DELEGATE_UPDATED", targetType: "console_account", targetReference: id, details: { status, services } }).catch(() => undefined);
  const row = rowsToObjects(await turso(`SELECT a.id,a.name,a.email,a.status,d.services,d.must_change_password,d.created_at,d.updated_at
    FROM console_admin_delegates d JOIN console_accounts a ON a.id=d.account_id WHERE a.id=? LIMIT 1`, [id]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "Delegate account not found.", 404);
  return delegateView(row);
}
