import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables, getHostelLandlord } from "@/lib/hostel-engine/landlord";
import { queueNotification } from "@/lib/notifications";
import { findPayoutDestination, isPayoutMethod, type PayoutMethod } from "@/lib/paystack-banks";
import { lastFour, maskAccountNumber, openSecret, sealSecret } from "@/lib/secret-box";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Money out of the hostel ledger.
 *
 * A paid booking already wrote an `ACCRUED` row into `hostel_payouts`: gross,
 * the platform's 9%, and the landlord's share. This module is the other half —
 * who is owed what, the account the money should reach, and the batch that
 * marks entries `RELEASED` once an administrator has actually transferred them.
 *
 * The release policy is the one the rollout plan set: an entry becomes payable
 * three days before the academic year starts (`release_after`), so a student
 * who changes their mind before move-in can still be refunded out of money the
 * platform has not yet sent on.
 */

/** One batch should stay reviewable by a person; a landlord's year is not one row. */
export const HOSTEL_PAYOUT_BATCH_MAX_ENTRIES = 500;

const PAYOUT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_payout_batches (
    id TEXT PRIMARY KEY,
    landlord_id TEXT NOT NULL,
    total_amount INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0,
    transfer_reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_payout_batches_landlord ON hostel_payout_batches(landlord_id, created_at DESC)",
  "ALTER TABLE hostel_payouts ADD COLUMN batch_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payouts ADD COLUMN transfer_reference TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payouts ADD COLUMN released_by TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_hostel_payouts_batch ON hostel_payouts(batch_id)",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_method TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_account_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_account_number TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_account_last4 TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_bank_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_bank_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN payout_updated_at TEXT NOT NULL DEFAULT ''",
];

let payoutTablesReady: Promise<void> | null = null;

/** Memoised per isolate; a console read must not run DDL on every request. */
export function ensureHostelPayoutTables() {
  payoutTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ id: "hostel_payouts", version: "016_hostel_payouts", statements: PAYOUT_SCHEMA_STATEMENTS });
  })().catch((error: unknown) => {
    payoutTablesReady = null;
    throw error;
  });
  return payoutTablesReady;
}

export type HostelPayoutEntry = {
  id: string;
  bookingId: string;
  bookingReference: string;
  propertyName: string;
  studentName: string;
  periodName: string;
  grossAmount: number;
  commissionBps: number;
  commissionAmount: number;
  netAmount: number;
  status: string;
  releaseAfter: string;
  releasedAt: string;
  transferReference: string;
  createdAt: string;
};

export type HostelPayoutBatchRecord = {
  id: string;
  landlordId: string;
  totalAmount: number;
  entryCount: number;
  transferReference: string;
  note: string;
  createdBy: string;
  createdAt: string;
};

/** A landlord with money in the ledger, whether or not it is payable yet. */
export type HostelPayoutLandlord = {
  id: string;
  name: string;
  organization: string;
  email: string;
  phone: string;
  status: string;
  kycStatus: string;
  commissionBps: number;
  /** Everything accrued and not yet released, payable or not. */
  accruedAmount: number;
  /** The part whose release date has passed: what may be paid today. */
  payableAmount: number;
  payableCount: number;
  releasedAmount: number;
  entryCount: number;
  payoutMethod: string;
  payoutAccountName: string;
  payoutAccountMasked: string;
  payoutBankName: string;
  payoutUpdatedAt: string;
  payoutReady: boolean;
};

export type HostelPayoutAccount = {
  method: string;
  accountName: string;
  accountMasked: string;
  last4: string;
  bankCode: string;
  bankName: string;
  updatedAt: string;
  /** True when a transfer can be addressed: a destination and a number exist. */
  ready: boolean;
};

const PAYOUT_ENTRY_COLUMNS = `p.id,p.booking_id,p.landlord_id,p.gross_amount,p.commission_bps,p.commission_amount,p.net_amount,
  COALESCE(p.status,'ACCRUED') AS status,p.release_after,COALESCE(p.released_at,'') AS released_at,
  COALESCE(p.transfer_reference,'') AS transfer_reference,p.created_at,
  COALESCE(b.reference,'') AS booking_reference,COALESCE(b.student_name,'') AS student_name,
  COALESCE(prop.name,'') AS property_name,COALESCE(pe.name,'') AS period_name`;

const PAYOUT_ENTRY_JOINS = `FROM hostel_payouts p
  LEFT JOIN hostel_bookings b ON b.id = p.booking_id
  LEFT JOIN hostel_properties prop ON prop.id = b.property_id
  LEFT JOIN hostel_periods pe ON pe.id = b.period_id`;

function payoutEntryView(row: Record<string, unknown>): HostelPayoutEntry {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    bookingReference: String(row.booking_reference || ""),
    propertyName: String(row.property_name || ""),
    studentName: String(row.student_name || ""),
    periodName: String(row.period_name || ""),
    grossAmount: Number(row.gross_amount || 0),
    commissionBps: Number(row.commission_bps || 0),
    commissionAmount: Number(row.commission_amount || 0),
    netAmount: Number(row.net_amount || 0),
    status: String(row.status || "ACCRUED"),
    releaseAfter: String(row.release_after || ""),
    releasedAt: String(row.released_at || ""),
    transferReference: String(row.transfer_reference || ""),
    createdAt: String(row.created_at || ""),
  };
}

function batchView(row: Record<string, unknown>): HostelPayoutBatchRecord {
  return {
    id: String(row.id || ""),
    landlordId: String(row.landlord_id || ""),
    totalAmount: Number(row.total_amount || 0),
    entryCount: Number(row.entry_count || 0),
    transferReference: String(row.transfer_reference || ""),
    note: String(row.note || ""),
    createdBy: String(row.created_by || ""),
    createdAt: String(row.created_at || ""),
  };
}

/**
 * Every landlord holding ledger rows, with the payable part separated from the
 * part that is still inside its release window. One query, because this is the
 * page an administrator opens before sending any money.
 */
export async function listHostelPayoutLandlords(now = new Date()) {
  await ensureHostelPayoutTables();
  const stamp = now.toISOString();
  const rows = rowsToObjects(await turso(
    `SELECT l.id,l.name,COALESCE(l.organization,'') AS organization,COALESCE(l.email,'') AS email,COALESCE(l.phone,'') AS phone,
       COALESCE(l.status,'ACTIVE') AS status,COALESCE(l.kyc_status,'PENDING') AS kyc_status,COALESCE(l.commission_bps,900) AS commission_bps,
       COALESCE(l.payout_method,'') AS payout_method,COALESCE(l.payout_account_name,'') AS payout_account_name,
       COALESCE(l.payout_account_last4,'') AS payout_account_last4,COALESCE(l.payout_bank_name,'') AS payout_bank_name,
       COALESCE(l.payout_updated_at,'') AS payout_updated_at,
       COALESCE(SUM(CASE WHEN p.status = 'ACCRUED' THEN p.net_amount ELSE 0 END),0) AS accrued_amount,
       COALESCE(SUM(CASE WHEN p.status = 'ACCRUED' AND p.release_after <= ? THEN p.net_amount ELSE 0 END),0) AS payable_amount,
       COALESCE(SUM(CASE WHEN p.status = 'ACCRUED' AND p.release_after <= ? THEN 1 ELSE 0 END),0) AS payable_count,
       COALESCE(SUM(CASE WHEN p.status = 'RELEASED' THEN p.net_amount ELSE 0 END),0) AS released_amount,
       COUNT(p.id) AS entry_count
     FROM hostel_landlords l
     JOIN hostel_payouts p ON p.landlord_id = l.id
     GROUP BY l.id
     ORDER BY payable_amount DESC, accrued_amount DESC`,
    [stamp, stamp],
  ));
  const landlords = rows.map((row): HostelPayoutLandlord => ({
    id: String(row.id || ""),
    name: String(row.name || ""),
    organization: String(row.organization || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    status: String(row.status || "ACTIVE"),
    kycStatus: String(row.kyc_status || "PENDING"),
    commissionBps: Number(row.commission_bps || 900),
    accruedAmount: Number(row.accrued_amount || 0),
    payableAmount: Number(row.payable_amount || 0),
    payableCount: Number(row.payable_count || 0),
    releasedAmount: Number(row.released_amount || 0),
    entryCount: Number(row.entry_count || 0),
    payoutMethod: String(row.payout_method || ""),
    payoutAccountName: String(row.payout_account_name || ""),
    payoutAccountMasked: maskAccountNumber(String(row.payout_account_last4 || "")),
    payoutBankName: String(row.payout_bank_name || ""),
    payoutUpdatedAt: String(row.payout_updated_at || ""),
    payoutReady: Boolean(String(row.payout_method || "") && String(row.payout_account_last4 || "")),
  }));
  const totals = landlords.reduce((sum, landlord) => ({
    accruedAmount: sum.accruedAmount + landlord.accruedAmount,
    payableAmount: sum.payableAmount + landlord.payableAmount,
    releasedAmount: sum.releasedAmount + landlord.releasedAmount,
    payableCount: sum.payableCount + landlord.payableCount,
  }), { accruedAmount: 0, payableAmount: 0, releasedAmount: 0, payableCount: 0 });
  return { landlords, totals };
}

/** One landlord's ledger: the entries behind the balance and the batches already paid. */
export async function hostelPayoutStatement(landlordId: string, options: { limit?: number } = {}) {
  await ensureHostelPayoutTables();
  const id = String(landlordId || "").trim();
  if (!id) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord.", 400);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 500);
  const entries = rowsToObjects(await turso(
    `SELECT ${PAYOUT_ENTRY_COLUMNS} ${PAYOUT_ENTRY_JOINS} WHERE p.landlord_id = ? ORDER BY p.created_at DESC LIMIT ${limit}`,
    [id],
  )).map(payoutEntryView);
  const batches = rowsToObjects(await turso(
    `SELECT * FROM hostel_payout_batches WHERE landlord_id = ? ORDER BY created_at DESC LIMIT 50`,
    [id],
  )).map(batchView);
  const now = new Date().toISOString();
  const totals = entries.reduce((sum, entry) => {
    if (entry.status === "RELEASED") return { ...sum, releasedAmount: sum.releasedAmount + entry.netAmount };
    if (entry.status === "ACCRUED" && entry.releaseAfter <= now) return { ...sum, payableAmount: sum.payableAmount + entry.netAmount };
    return { ...sum, accruedAmount: sum.accruedAmount + entry.netAmount };
  }, { accruedAmount: 0, payableAmount: 0, releasedAmount: 0 });
  return { entries, batches, totals };
}

/** What the whole platform still owes landlords, split the same way. */
export async function platformHostelPayoutBalance(now = new Date()) {
  await ensureHostelPayoutTables();
  const stamp = now.toISOString();
  const row = rowsToObjects(await turso(
    `SELECT COALESCE(SUM(CASE WHEN status = 'ACCRUED' AND release_after <= ? THEN net_amount ELSE 0 END),0) AS payable_amount,
       COALESCE(SUM(CASE WHEN status = 'ACCRUED' THEN net_amount ELSE 0 END),0) AS accrued_amount,
       COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN net_amount ELSE 0 END),0) AS released_amount,
       COALESCE(SUM(commission_amount),0) AS commission_amount
     FROM hostel_payouts`,
    [stamp],
  ))[0];
  return {
    payableAmount: Number(row?.payable_amount || 0),
    accruedAmount: Number(row?.accrued_amount || 0),
    releasedAmount: Number(row?.released_amount || 0),
    commissionAmount: Number(row?.commission_amount || 0),
  };
}

/**
 * Records a payout an administrator has already made by transfer. Entries move
 * to `RELEASED` together under one reference, and the status check is part of
 * the UPDATE so two administrators cannot release the same entry twice.
 */
export async function recordHostelPayoutBatch(input: {
  landlordId: string;
  reference?: unknown;
  note?: unknown;
  actor: string;
}) {
  await ensureHostelPayoutTables();
  const landlordId = String(input.landlordId || "").trim();
  const reference = String(input.reference || "").trim();
  const note = String(input.note || "").trim().slice(0, 300);
  const actor = String(input.actor || "").trim();
  if (!landlordId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord to pay.", 400);
  if (reference.length < 3 || reference.length > 80) {
    throw new CampusEngineError("VALIDATION_ERROR", "Record the transfer reference you were given (3-80 characters).", 400);
  }
  const landlord = await getHostelLandlord(landlordId);
  if (landlord.status !== "ACTIVE") {
    throw new CampusEngineError("INVALID_STATE", "Reactivate the landlord account before recording a payout.", 409);
  }
  // KYC is the money gate, exactly as it is for organizers: an unverified
  // landlord is who the gate exists to stop.
  if (landlord.kycStatus !== "VERIFIED") {
    throw new CampusEngineError("INVALID_STATE", "Verify the landlord's KYC before recording a payout.", 409);
  }
  const account = await getHostelPayoutAccount(landlordId);
  if (!account.ready) {
    throw new CampusEngineError("INVALID_STATE", "The landlord has not saved a payout account yet.", 409);
  }

  const now = new Date();
  const stamp = now.toISOString();
  const eligible = rowsToObjects(await turso(
    "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM hostel_payouts WHERE landlord_id = ? AND status = 'ACCRUED' AND release_after <= ?",
    [landlordId, stamp],
  ))[0];
  const eligibleCount = Number(eligible?.entry_count || 0);
  if (!eligibleCount) {
    throw new CampusEngineError("INVALID_STATE", "No hostel payout is ready yet: an entry releases three days before the academic year starts.", 409);
  }
  if (eligibleCount > HOSTEL_PAYOUT_BATCH_MAX_ENTRIES) {
    throw new CampusEngineError("INVALID_STATE", "More entries are ready than one batch should carry. Record them in smaller batches.", 409);
  }

  const batchId = crypto.randomUUID();
  await turso(
    "INSERT INTO hostel_payout_batches (id,landlord_id,total_amount,entry_count,transfer_reference,note,created_by,created_at,updated_at) VALUES (?,?,0,0,?,?,?,?,?)",
    [batchId, landlordId, reference, note, actor, stamp, stamp],
  );
  await turso(
    `UPDATE hostel_payouts SET status = 'RELEASED', batch_id = ?, transfer_reference = ?, released_at = ?, released_by = ?, updated_at = ?
     WHERE landlord_id = ? AND status = 'ACCRUED' AND release_after <= ?`,
    [batchId, reference, stamp, actor, stamp, landlordId, stamp],
  );
  const claimed = rowsToObjects(await turso(
    "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM hostel_payouts WHERE batch_id = ?",
    [batchId],
  ))[0];
  const entryCount = Number(claimed?.entry_count || 0);
  const totalAmount = Number(claimed?.total_amount || 0);
  if (!entryCount) {
    await turso("DELETE FROM hostel_payout_batches WHERE id = ?", [batchId]).catch(() => undefined);
    throw new CampusEngineError("INVALID_STATE", "Another payout just recorded those entries. Reload the statement.", 409);
  }
  await turso("UPDATE hostel_payout_batches SET total_amount = ?, entry_count = ?, updated_at = ? WHERE id = ?", [totalAmount, entryCount, stamp, batchId]);
  await consoleAudit({
    actor,
    action: "HOSTEL_PAYOUT_RECORDED",
    targetType: "hostel_landlord",
    targetReference: landlordId,
    details: { batchId, reference, totalAmount, entryCount },
  }).catch(() => undefined);
  await queueNotification(turso, {
    recipient: landlord.email,
    template: "hostel_payout_recorded",
    subject: `Payout sent: GH₵${(totalAmount / 100).toFixed(2)}`,
    message: `We released ${entryCount} paid booking${entryCount === 1 ? "" : "s"} of hostel earnings to you under transfer reference ${reference}. Your statement in the console shows which residents it covers.`,
    reference: batchId,
    nowIso: stamp,
  }).catch(() => undefined);
  return { id: batchId, landlordId, totalAmount, entryCount, transferReference: reference, note, createdAt: stamp };
}

/**
 * The account a payout is addressed to. Only the owner may set it: a manager
 * runs the building, but the money must not be able to walk somewhere else.
 */
export async function saveHostelPayoutAccount(input: {
  landlordId: string;
  method?: unknown;
  accountName?: unknown;
  accountNumber?: unknown;
  bankCode?: unknown;
  actor: string;
}): Promise<HostelPayoutAccount> {
  await ensureHostelPayoutTables();
  const landlordId = String(input.landlordId || "").trim();
  if (!landlordId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord.", 400);
  const method = String(input.method || "").trim().toUpperCase();
  const accountName = String(input.accountName || "").trim();
  const accountNumber = String(input.accountNumber || "").trim();
  if (!isPayoutMethod(method)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose a bank account or a mobile money account.", 400);
  }
  if (!accountName) throw new CampusEngineError("VALIDATION_ERROR", "Enter the account holder's name.", 400);
  if (accountNumber.length < 5 || accountNumber.length > 40 || !/^[0-9A-Za-z -]+$/.test(accountNumber)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter the account or mobile money number.", 400);
  }
  // The destination is part of the address: a transfer sent with the wrong bank
  // code reaches the wrong institution, so an unknown code is refused here.
  const destination = await findPayoutDestination(method as PayoutMethod, input.bankCode);
  if (!destination) {
    throw new CampusEngineError(
      "VALIDATION_ERROR",
      method === "BANK" ? "Choose the bank that holds this account." : "Choose the mobile money network.",
      400,
    );
  }
  const stamp = new Date().toISOString();
  await turso(
    `UPDATE hostel_landlords SET payout_method=?,payout_account_name=?,payout_account_number=?,payout_account_last4=?,
       payout_bank_code=?,payout_bank_name=?,payout_updated_at=?,updated_at=? WHERE id=?`,
    [method, accountName, await sealSecret(accountNumber), lastFour(accountNumber), destination.code, destination.name, stamp, stamp, landlordId],
  );
  await consoleAudit({
    actor: input.actor,
    action: "HOSTEL_PAYOUT_ACCOUNT_SAVED",
    targetType: "hostel_landlord",
    targetReference: landlordId,
    // The last four recognise a change; the number itself is never audited.
    details: { method, last4: lastFour(accountNumber), destination: destination.name },
  }).catch(() => undefined);
  return getHostelPayoutAccount(landlordId);
}

/** The masked read: enough to recognise the account, never enough to move money. */
export async function getHostelPayoutAccount(landlordId: string): Promise<HostelPayoutAccount> {
  await ensureHostelPayoutTables();
  const row = rowsToObjects(await turso(
    `SELECT COALESCE(payout_method,'') AS payout_method,COALESCE(payout_account_name,'') AS payout_account_name,
       COALESCE(payout_account_last4,'') AS payout_account_last4,COALESCE(payout_bank_code,'') AS payout_bank_code,
       COALESCE(payout_bank_name,'') AS payout_bank_name,COALESCE(payout_updated_at,'') AS payout_updated_at
     FROM hostel_landlords WHERE id = ? LIMIT 1`,
    [String(landlordId || "")],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That landlord account no longer exists.", 404);
  const method = String(row.payout_method || "");
  const last4 = String(row.payout_account_last4 || "");
  return {
    method,
    accountName: String(row.payout_account_name || ""),
    accountMasked: maskAccountNumber(last4),
    last4,
    bankCode: String(row.payout_bank_code || ""),
    bankName: String(row.payout_bank_name || ""),
    updatedAt: String(row.payout_updated_at || ""),
    ready: Boolean(method && last4),
  };
}

/** The one way to read a full number back. Every call is audited. */
export async function revealHostelPayoutAccount(landlordId: string, actor: string) {
  await ensureHostelPayoutTables();
  const row = rowsToObjects(await turso(
    "SELECT COALESCE(payout_account_number,'') AS payout_account_number FROM hostel_landlords WHERE id = ? LIMIT 1",
    [String(landlordId || "")],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That landlord account no longer exists.", 404);
  const accountNumber = await openSecret(row.payout_account_number);
  await consoleAudit({
    actor,
    action: "HOSTEL_PAYOUT_ACCOUNT_REVEALED",
    targetType: "hostel_landlord",
    targetReference: String(landlordId),
    details: { fields: accountNumber ? ["payoutAccountNumber"] : [] },
  });
  return { accountNumber: accountNumber || "" };
}
