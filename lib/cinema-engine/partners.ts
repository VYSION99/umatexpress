import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertConsolePassword, createConsoleAccount, ensureConsoleAccountsTable, revokeConsoleSessions } from "@/lib/console-auth";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";
import { consoleAudit } from "@/lib/console-audit";

export const CINEMA_PARTNER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cinema_partner_profiles (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    organization_name TEXT NOT NULL,
    venue_type TEXT NOT NULL DEFAULT 'VENUE',
    status TEXT NOT NULL DEFAULT 'PENDING',
    review_note TEXT NOT NULL DEFAULT '',
    verified_at TEXT NOT NULL DEFAULT '',
    verified_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_partner_status ON cinema_partner_profiles(status, created_at DESC)`,
];

let ready: Promise<void> | null = null;
export function ensureCinemaPartnerTables() {
  ready ??= Promise.all([
    ensureConsoleAccountsTable(),
    runSchemaPass({ id: "cinema-partners", version: "1", statements: CINEMA_PARTNER_SCHEMA }),
  ]).then(() => undefined).catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

export type CinemaPartner = {
  id: string;
  accountId: string;
  organizationName: string;
  venueType: string;
  status: string;
  reviewNote: string;
  verifiedAt: string;
  verifiedBy: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
};

function view(row: Record<string, unknown>): CinemaPartner {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    organizationName: String(row.organization_name),
    venueType: String(row.venue_type || "VENUE"),
    status: String(row.status),
    reviewNote: String(row.review_note || ""),
    verifiedAt: String(row.verified_at || ""),
    verifiedBy: String(row.verified_by || ""),
    name: String(row.name || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

const SELECT = `SELECT p.*, a.name, a.email, a.phone FROM cinema_partner_profiles p JOIN console_accounts a ON a.id = p.account_id`;

export async function registerCinemaPartner(input: Record<string, unknown>) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Cinema partner applications are unavailable on this deployment.", 503);
  }
  const name = String(input.name || "").trim();
  const organizationName = String(input.organization || input.organizationName || "").trim();
  const phone = String(input.phone || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");

  if (name.length < 2 || organizationName.length < 2 || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter your name, organization or screening venue, phone number and a valid email address.", 400);
  }

  assertConsolePassword("CINEMA", password);
  await ensureCinemaPartnerTables();

  const existing = rowsToObjects(await turso("SELECT id FROM console_accounts WHERE lower(email)=? LIMIT 1", [email]));
  if (existing.length) {
    throw new CampusEngineError("CONFLICT", "That email already belongs to a console account.", 409);
  }

  const id = crypto.randomUUID();
  let accountId = "";
  try {
    accountId = await createConsoleAccount({
      email,
      password,
      name,
      phone,
      role: "CINEMA",
      profileId: id,
      status: "ACTIVE",
    });
    const now = new Date().toISOString();
    await turso(
      "INSERT INTO cinema_partner_profiles (id, account_id, organization_name, venue_type, status, created_at, updated_at) VALUES (?, ?, ?, 'VENUE', 'PENDING', ?, ?)",
      [id, accountId, organizationName, now, now],
    );
    return { id, accountId, status: "PENDING" };
  } catch (error) {
    if (accountId) {
      await turso("DELETE FROM console_accounts WHERE id=? AND role='CINEMA'", [accountId]).catch(() => undefined);
    }
    throw error;
  }
}

export async function listCinemaPartners(statusFilter?: string) {
  await ensureCinemaPartnerTables();
  if (statusFilter && statusFilter !== "ALL") {
    return rowsToObjects(await turso(`${SELECT} WHERE p.status = ? ORDER BY p.created_at DESC`, [statusFilter])).map(view);
  }
  return rowsToObjects(await turso(`${SELECT} ORDER BY CASE p.status WHEN 'PENDING' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END, p.created_at DESC`)).map(view);
}

export async function cinemaPartnerForAccount(accountId: string): Promise<CinemaPartner | null> {
  await ensureCinemaPartnerTables();
  const row = rowsToObjects(await turso(`${SELECT} WHERE p.account_id = ? LIMIT 1`, [accountId]))[0];
  return row ? view(row) : null;
}

export async function decideCinemaPartner(input: {
  partnerId: string;
  approve: boolean;
  actor: string;
  reviewNote?: string;
}) {
  await ensureCinemaPartnerTables();
  const partnerId = String(input.partnerId || "").trim();
  const reviewNote = String(input.reviewNote || "").trim();
  if (!partnerId) {
    throw new CampusEngineError("VALIDATION_ERROR", "Partner ID is required.", 400);
  }
  if (!input.approve && reviewNote.length < 5) {
    throw new CampusEngineError("VALIDATION_ERROR", "Record a rejection reason of at least 5 characters.", 400);
  }

  const existingRow = rowsToObjects(await turso("SELECT id, account_id, status FROM cinema_partner_profiles WHERE id = ? LIMIT 1", [partnerId]))[0];
  if (!existingRow) {
    throw new CampusEngineError("NOT_FOUND", "Cinema partner profile not found.", 404);
  }

  const newStatus = input.approve ? "ACTIVE" : "REJECTED";
  const now = new Date().toISOString();
  await turso(
    "UPDATE cinema_partner_profiles SET status = ?, verified_at = ?, verified_by = ?, review_note = ?, updated_at = ? WHERE id = ?",
    [newStatus, input.approve ? now : "", input.actor, reviewNote, now, partnerId],
  );

  if (!input.approve) {
    await revokeConsoleSessions(String(existingRow.account_id)).catch(() => undefined);
  }

  await consoleAudit({
    actor: input.actor,
    action: input.approve ? "CINEMA_PARTNER_APPROVED" : "CINEMA_PARTNER_REJECTED",
    targetType: "cinema_partner",
    targetReference: partnerId,
  });

  return { id: partnerId, status: newStatus };
}
