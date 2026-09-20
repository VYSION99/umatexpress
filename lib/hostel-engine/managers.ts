import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertConsolePassword, consoleAccountRowByIdentifier, createConsoleAccount, revokeConsoleSessions, setConsolePassword } from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { incrementMetric } from "@/lib/observability";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Delegate managers.
 *
 * A landlord who owns several buildings cannot always be the person who answers
 * residents or switches a service on, so they may appoint managers. A manager
 * is a normal console account whose `profile_id` points at the landlord, which
 * is why every landlord route keeps working unchanged; membership in
 * `hostel_managers` is what makes that account legitimate, and the owner's
 * email is what separates "may run the hostel" from "may appoint managers".
 */

export type HostelManager = {
  id: string;
  landlordId: string;
  name: string;
  email: string;
  phone: string;
  status: string;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
};

const MANAGER_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_managers (
    id TEXT PRIMARY KEY,
    landlord_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    invited_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_managers_email ON hostel_managers(landlord_id, email)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_managers_landlord ON hostel_managers(landlord_id, status)",
];

let managerTablesReady: Promise<void> | null = null;

export function ensureHostelManagerTables() {
  managerTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ id: "hostel_managers", version: "015_hostel_managers", statements: MANAGER_SCHEMA_STATEMENTS });
  })();
  return managerTablesReady;
}

function managerView(row: Record<string, unknown>): HostelManager {
  return {
    id: String(row.id || ""),
    landlordId: String(row.landlord_id || ""),
    name: String(row.name || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    status: String(row.status || "ACTIVE"),
    invitedBy: String(row.invited_by || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export type HostelHostAccess = {
  landlordId: string;
  isOwner: boolean;
  managerId: string;
  email: string;
};

/**
 * Turns a signed console account into a hostel host: the owner, or a manager
 * the owner appointed. Anything else — including a landlord account pointing at
 * a different profile — is refused rather than trusted.
 */
export async function resolveHostelHost(account: { email: string; profileId?: string }): Promise<HostelHostAccess> {
  await ensureHostelManagerTables();
  if (!account.profileId) {
    throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to a landlord profile.", 401);
  }
  const landlord = rowsToObjects(await turso("SELECT id,COALESCE(email,'') AS email FROM hostel_landlords WHERE id = ? LIMIT 1", [account.profileId]))[0];
  if (!landlord) throw new CampusEngineError("NOT_FOUND", "That landlord account no longer exists.", 404);
  const ownerEmail = String(landlord.email || "").trim().toLowerCase();
  const email = String(account.email || "").trim().toLowerCase();
  if (!ownerEmail || ownerEmail === email) {
    return { landlordId: String(landlord.id), isOwner: true, managerId: "", email };
  }
  const manager = rowsToObjects(await turso(
    "SELECT id FROM hostel_managers WHERE landlord_id = ? AND lower(email) = ? AND status = 'ACTIVE' LIMIT 1",
    [String(landlord.id), email],
  ))[0];
  if (!manager) {
    throw new CampusEngineError("FORBIDDEN", "Your account is not an active manager for this landlord.", 403);
  }
  return { landlordId: String(landlord.id), isOwner: false, managerId: String(manager.id), email };
}

export function assertHostelOwner(access: HostelHostAccess) {
  if (!access.isOwner) throw new CampusEngineError("FORBIDDEN", "Only the landlord owner can do that.", 403);
  return access;
}

export async function listHostelManagers(landlordId: string) {
  await ensureHostelManagerTables();
  const rows = rowsToObjects(await turso("SELECT * FROM hostel_managers WHERE landlord_id = ? ORDER BY created_at DESC", [landlordId]));
  return rows.map(managerView);
}

export async function inviteHostelManager(input: {
  landlordId: string;
  actorEmail: string;
  name: unknown;
  email: unknown;
  phone?: unknown;
  password: unknown;
}) {
  await ensureHostelManagerTables();
  const name = String(input.name ?? "").trim().slice(0, 100);
  const email = String(input.email ?? "").trim().toLowerCase();
  const phone = String(input.phone ?? "").trim().slice(0, 30);
  const password = String(input.password ?? "");
  if (!name || !email) throw new CampusEngineError("VALIDATION_ERROR", "Enter the manager's name and email address.", 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CampusEngineError("VALIDATION_ERROR", "Enter a valid email address.", 400);
  assertConsolePassword("LANDLORD", password);

  const landlord = rowsToObjects(await turso("SELECT COALESCE(email,'') AS email FROM hostel_landlords WHERE id = ? LIMIT 1", [input.landlordId]))[0];
  if (String(landlord?.email || "").trim().toLowerCase() === email) {
    throw new CampusEngineError("CONFLICT", "That address already runs this account as its owner.", 409);
  }
  const existing = rowsToObjects(await turso("SELECT id,status FROM hostel_managers WHERE landlord_id = ? AND lower(email) = ? LIMIT 1", [input.landlordId, email]))[0];
  const account = await consoleAccountRowByIdentifier(email);
  if (account && String(account.profile_id || "") !== input.landlordId) {
    throw new CampusEngineError("CONFLICT", "That email address is already registered on the console.", 409);
  }

  const stamp = new Date().toISOString();
  let managerId = existing ? String(existing.id) : "";
  if (account && account.id) {
    // The account already exists for this landlord: reactivate it as a manager
    // and set the password the owner just chose. Without that write, an account
    // that was revoked (its password retired with it) could never sign in again.
    await turso(
      "UPDATE console_accounts SET role = 'LANDLORD', status = 'ACTIVE', name = ?, phone = ?, updated_at = ? WHERE id = ?",
      [name, phone, stamp, String(account.id)],
    );
    await setConsolePassword(String(account.id), password);
  } else {
    await createConsoleAccount({ email, password, name, phone, role: "LANDLORD", profileId: input.landlordId, status: "ACTIVE" });
  }
  if (managerId) {
    await turso("UPDATE hostel_managers SET name = ?, phone = ?, status = 'ACTIVE', invited_by = ?, updated_at = ? WHERE id = ?", [name, phone, input.actorEmail, stamp, managerId]);
  } else {
    managerId = crypto.randomUUID();
    await turso(
      "INSERT INTO hostel_managers (id,landlord_id,name,email,phone,status,invited_by,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)",
      [managerId, input.landlordId, name, email, phone, input.actorEmail, stamp, stamp],
    );
  }
  await incrementMetric("hostel_manager_invited");
  await consoleAudit({
    actor: input.actorEmail, action: "HOSTEL_MANAGER_INVITED", targetType: "hostel_manager", targetReference: managerId,
    details: { email },
  }).catch(() => undefined);
  const rows = rowsToObjects(await turso("SELECT * FROM hostel_managers WHERE id = ? LIMIT 1", [managerId]));
  return rows[0] ? managerView(rows[0]) : null;
}

export async function revokeHostelManager(input: { landlordId: string; managerId: string; actorEmail: string }) {
  await ensureHostelManagerTables();
  const manager = rowsToObjects(await turso("SELECT * FROM hostel_managers WHERE id = ? AND landlord_id = ? LIMIT 1", [String(input.managerId || ""), input.landlordId]))[0];
  if (!manager) throw new CampusEngineError("NOT_FOUND", "That manager was not found.", 404);
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_managers SET status = 'REVOKED', updated_at = ? WHERE id = ?", [stamp, String(manager.id)]);
  const account = await consoleAccountRowByIdentifier(String(manager.email));
  if (account && String(account.profile_id || "") === input.landlordId) {
    await turso("UPDATE console_accounts SET status = 'SUSPENDED', updated_at = ? WHERE id = ?", [stamp, String(account.id)]);
    await revokeConsoleSessions(String(account.id));
  }
  await consoleAudit({
    actor: input.actorEmail, action: "HOSTEL_MANAGER_REVOKED", targetType: "hostel_manager", targetReference: String(manager.id),
    details: { email: String(manager.email) },
  }).catch(() => undefined);
  return { ok: true, managerId: String(manager.id) };
}
