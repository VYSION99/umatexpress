import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables, getHostelLandlord, HOSTEL_DEFAULT_COMMISSION_BPS } from "@/lib/hostel-engine/landlord";
import { queueNotification } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";
import { createPaystackRecipient, initiatePaystackTransfer, verifyPaystackTransfer } from "@/lib/paystack";
import { findPayoutDestination, isPayoutMethod, recipientTypeFor, type PayoutMethod } from "@/lib/paystack-banks";
import { platformSettingEnabled, platformSettingState } from "@/lib/platform-settings";
import { envValue } from "@/lib/runtime-env";
import { lastFour, maskAccountNumber, openSecret, sealSecret } from "@/lib/secret-box";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Money out of the hostel ledger.
 *
 * A paid booking already wrote an `ACCRUED` row into `hostel_payouts`: gross,
 * the platform's 3%, and the landlord's share. This module is the other half —
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

/** After this many failed sends the entries stop being retried automatically. */
export const HOSTEL_PAYOUT_MAX_ATTEMPTS = 3;
/** A transfer this fresh is not stuck; the wait keeps a job off its own send. */
const HOSTEL_PAYOUT_RECONCILE_WAIT_MS = 2 * 60_000;
const HOSTEL_PAYOUT_RECONCILE_LIMIT = 20;

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

/**
 * Phase 3's transfer half. A batch sent through Paystack carries the codes
 * Paystack gave back, so a webhook or the reconcile job can find it again, and
 * an entry that failed to send returns to the ledger through `payout_attempts`
 * rather than being lost as `PROCESSING`.
 */
const PAYOUT_TRANSFER_STATEMENTS = [
  "ALTER TABLE hostel_payout_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'MANUAL'",
  "ALTER TABLE hostel_payout_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'RECORDED'",
  "ALTER TABLE hostel_payout_batches ADD COLUMN transfer_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payout_batches ADD COLUMN recipient_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payout_batches ADD COLUMN reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payout_batches ADD COLUMN initiated_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payout_batches ADD COLUMN settled_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_payouts ADD COLUMN payout_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hostel_payouts ADD COLUMN last_error TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_landlords ADD COLUMN paystack_recipient_code TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_hostel_payout_batches_inflight ON hostel_payout_batches(status, mode, initiated_at)",
];

/**
 * The unattended release is opt-in: a schedule that moves money is a choice.
 * An administrator flips it in the console's Platform settings, and
 * `HOSTEL_PAYOUT_AUTO_ENABLED` remains the fallback for a deployment that
 * never opens that page.
 */
export async function hostelPayoutAutoEnabled() {
  return platformSettingEnabled("hostel_payout_auto");
}

/** The switch as the payout desk shows it: on or off, and who decided. */
export async function hostelPayoutAutoState() {
  return platformSettingState("hostel_payout_auto");
}

/**
 * Money a refund clawed back after the transfer had already left. Like the trip
 * side, an entry that is reversed after release is not merely un-earned: the
 * landlord holds platform money, and the next batch waits until it is settled.
 */
export async function hostelPayoutDebt(landlordId: string) {
  await ensureHostelPayoutTables();
  const row = rowsToObjects(await turso(
    `SELECT COALESCE(SUM(p.net_amount),0) AS debt FROM hostel_payouts p
     WHERE p.landlord_id = ? AND p.status = 'REVERSED' AND COALESCE(p.released_at,'') <> ''`,
    [String(landlordId || "").trim()],
  ))[0];
  return Number(row?.debt || 0);
}

let payoutTablesReady: Promise<void> | null = null;

/** Memoised per isolate; a console read must not run DDL on every request. */
export function ensureHostelPayoutTables() {
  payoutTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ id: "hostel_payouts", version: "016_hostel_payouts", statements: PAYOUT_SCHEMA_STATEMENTS });
    await runSchemaPass({ id: "hostelPayoutTransfers", version: "019_hostel_payout_transfers", statements: PAYOUT_TRANSFER_STATEMENTS });
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
  /** AUTO when Paystack was asked to send it, MANUAL when a person recorded one. */
  mode: string;
  /** RECORDED (manual), PENDING (in flight), RELEASED, or FAILED. */
  status: string;
  transferCode: string;
  recipientCode: string;
  reason: string;
  initiatedAt: string;
  settledAt: string;
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
  /** Money a refund took back after it had already been transferred. */
  debtAmount: number;
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
    mode: String(row.mode || "MANUAL"),
    status: String(row.status || "RECORDED"),
    transferCode: String(row.transfer_code || ""),
    recipientCode: String(row.recipient_code || ""),
    reason: String(row.reason || ""),
    initiatedAt: String(row.initiated_at || ""),
    settledAt: String(row.settled_at || ""),
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
       COALESCE(l.status,'ACTIVE') AS status,COALESCE(l.kyc_status,'PENDING') AS kyc_status,COALESCE(l.commission_bps,${HOSTEL_DEFAULT_COMMISSION_BPS}) AS commission_bps,
       COALESCE(l.payout_method,'') AS payout_method,COALESCE(l.payout_account_name,'') AS payout_account_name,
       COALESCE(l.payout_account_last4,'') AS payout_account_last4,COALESCE(l.payout_bank_name,'') AS payout_bank_name,
       COALESCE(l.payout_updated_at,'') AS payout_updated_at,
       COALESCE(SUM(CASE WHEN p.status = 'ACCRUED' THEN p.net_amount ELSE 0 END),0) AS accrued_amount,
       COALESCE(SUM(CASE WHEN p.status = 'ACCRUED' AND p.release_after <= ? THEN p.net_amount ELSE 0 END),0) AS payable_amount,
       COALESCE(SUM(CASE WHEN p.status = 'ACCRUED' AND p.release_after <= ? THEN 1 ELSE 0 END),0) AS payable_count,
       COALESCE(SUM(CASE WHEN p.status = 'RELEASED' THEN p.net_amount ELSE 0 END),0) AS released_amount,
       COALESCE(SUM(CASE WHEN p.status = 'REVERSED' AND COALESCE(p.released_at,'') <> '' THEN p.net_amount ELSE 0 END),0) AS debt_amount,
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
    commissionBps: Number(row.commission_bps || HOSTEL_DEFAULT_COMMISSION_BPS),
    accruedAmount: Number(row.accrued_amount || 0),
    payableAmount: Number(row.payable_amount || 0),
    payableCount: Number(row.payable_count || 0),
    releasedAmount: Number(row.released_amount || 0),
    debtAmount: Number(row.debt_amount || 0),
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
    if (entry.status === "REVERSED") {
      // A reversal before release is simply un-earned; one after release is a
      // debt the landlord owes back to the platform.
      return entry.releasedAt
        ? { ...sum, debtAmount: sum.debtAmount + entry.netAmount }
        : sum;
    }
    if (entry.status === "RELEASED") return { ...sum, releasedAmount: sum.releasedAmount + entry.netAmount };
    if (entry.status === "ACCRUED" && entry.releaseAfter <= now) return { ...sum, payableAmount: sum.payableAmount + entry.netAmount };
    return { ...sum, accruedAmount: sum.accruedAmount + entry.netAmount };
  }, { accruedAmount: 0, payableAmount: 0, releasedAmount: 0, debtAmount: 0 });
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
    "INSERT INTO hostel_payout_batches (id,landlord_id,total_amount,entry_count,transfer_reference,note,created_by,mode,status,settled_at,created_at,updated_at) VALUES (?,?,0,0,?,?,?,'MANUAL','RELEASED',?,?,?)",
    [batchId, landlordId, reference, note, actor, stamp, stamp, stamp],
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
       payout_bank_code=?,payout_bank_name=?,payout_updated_at=?,updated_at=?,paystack_recipient_code='' WHERE id=?`,
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

/**
 * The Paystack address for a landlord, created once and reused. Saving new
 * account details clears the stored code, so a transfer is never addressed
 * with codes that belong to an account the landlord has since replaced.
 */
export async function ensureHostelRecipient(landlordId: string, options: { actor?: string; landlord?: Awaited<ReturnType<typeof getHostelLandlord>> } = {}) {
  await ensureHostelPayoutTables();
  const landlord = options.landlord ?? await getHostelLandlord(String(landlordId || ""));
  if (landlord.status !== "ACTIVE") {
    throw new CampusEngineError("INVALID_STATE", "Reactivate the landlord account before paying out.", 409);
  }
  if (landlord.kycStatus !== "VERIFIED") {
    throw new CampusEngineError("INVALID_STATE", "Verify the landlord's KYC before paying out.", 409);
  }
  const account = await getHostelPayoutAccount(landlord.id);
  if (!account.ready) {
    throw new CampusEngineError("INVALID_STATE", "The landlord has not saved a payout account yet.", 409);
  }
  const stored = rowsToObjects(await turso(
    "SELECT COALESCE(paystack_recipient_code,'') AS paystack_recipient_code,COALESCE(payout_account_number,'') AS payout_account_number FROM hostel_landlords WHERE id = ? LIMIT 1",
    [landlord.id],
  ))[0];
  const cached = String(stored?.paystack_recipient_code || "");
  if (cached) return { recipientCode: cached, created: false };
  if (!account.bankCode) {
    // The destination is part of the address: a transfer without an
    // institution would be sent to whoever the number happens to name.
    throw new CampusEngineError("INVALID_STATE", "The landlord's bank or network is missing, so a transfer cannot be addressed.", 409);
  }
  const accountNumber = await openSecret(stored?.payout_account_number);
  if (!accountNumber) {
    // Sealed with a key that is no longer held: only the landlord can fix it
    // by saving the details again.
    throw new CampusEngineError("INVALID_STATE", "The landlord's account number cannot be read. Ask them to save it again.", 409);
  }
  const currency = (await envValue("PAYSTACK_CURRENCY")) || "GHS";
  const created = await createPaystackRecipient({
    type: recipientTypeFor(account.method as PayoutMethod),
    name: account.accountName || landlord.name,
    accountNumber,
    bankCode: account.bankCode,
    currency,
    email: landlord.email || undefined,
    description: `UMaTeXPRESS hostel landlord ${landlord.id}`,
  });
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_landlords SET paystack_recipient_code=?,updated_at=? WHERE id=?", [created.recipientCode, stamp, landlord.id]);
  await consoleAudit({
    actor: String(options.actor || "system:payouts"),
    action: "HOSTEL_RECIPIENT_CREATED",
    targetType: "hostel_landlord",
    targetReference: landlord.id,
    // The recipient code is an address, not a secret, but the account number
    // that produced it never reaches the audit trail.
    details: { recipientCode: created.recipientCode, method: account.method, bankCode: account.bankCode },
  }).catch(() => undefined);
  return { recipientCode: created.recipientCode, created: true };
}

/**
 * Money has landed: the entries a batch claimed become `RELEASED`, and the
 * landlord hears about it once. Called by the send path when Paystack settles
 * inline and by the webhook/reconcile job when it settles later, so the
 * notification is keyed on the batch and cannot be sent twice.
 */
async function settleHostelPayoutBatch(input: { batchId: string; stamp: string; actor: string }) {
  await turso(
    `UPDATE hostel_payouts SET status = 'RELEASED', released_at = ?, released_by = ?, last_error = '', updated_at = ?
     WHERE batch_id = ? AND status = 'PROCESSING'`,
    [input.stamp, input.actor, input.stamp, input.batchId],
  );
  await turso("UPDATE hostel_payout_batches SET status='RELEASED', settled_at=?, reason='', updated_at=? WHERE id=?", [input.stamp, input.stamp, input.batchId]);
  const batch = rowsToObjects(await turso(
    `SELECT COALESCE(b.total_amount,0) AS total_amount,COALESCE(b.entry_count,0) AS entry_count,COALESCE(b.transfer_reference,'') AS transfer_reference,
       COALESCE(l.email,'') AS email,COALESCE(b.note,'') AS note
     FROM hostel_payout_batches b LEFT JOIN hostel_landlords l ON l.id = b.landlord_id WHERE b.id = ? LIMIT 1`,
    [input.batchId],
  ))[0];
  const email = String(batch?.email || "");
  if (!email) return;
  const totalAmount = Number(batch?.total_amount || 0);
  const entryCount = Number(batch?.entry_count || 0);
  const reference = String(batch?.transfer_reference || "");
  await queueNotification(turso, {
    recipient: email,
    template: "hostel_payout_recorded",
    subject: `Payout sent: GH₵${(totalAmount / 100).toFixed(2)}`,
    message: `We released ${entryCount} paid booking${entryCount === 1 ? "" : "s"} of hostel earnings to you. Paystack transfer ${reference} has settled, and your statement in the console shows which residents it covers.`,
    reference: input.batchId,
    nowIso: input.stamp,
  }).catch(() => undefined);
}

/**
 * The transfer did not land. The entries return to the ledger so the money is
 * still owed — a send that could not happen must not look like a send that did.
 * After the attempt ceiling the entry is `FAILED` instead, which takes it out of
 * the retry loop and asks for a person.
 */
async function failHostelPayoutBatch(input: { batchId: string; reason: string; stamp: string }) {
  const reason = String(input.reason || "TRANSFER_FAILED").slice(0, 200);
  await turso(
    `UPDATE hostel_payouts
       SET status = CASE WHEN payout_attempts + 1 >= ? THEN 'FAILED' ELSE 'ACCRUED' END,
           payout_attempts = payout_attempts + 1, last_error = ?, batch_id = '', updated_at = ?
     WHERE batch_id = ? AND status = 'PROCESSING'`,
    [HOSTEL_PAYOUT_MAX_ATTEMPTS, reason, input.stamp, input.batchId],
  );
  await turso("UPDATE hostel_payout_batches SET status='FAILED', reason=?, settled_at=?, updated_at=? WHERE id=?", [reason, input.stamp, input.stamp, input.batchId]);
}

/** The refusal an administrator sees when Paystack would not send the money. */
export type HostelPayoutSendResult = {
  batch: HostelPayoutBatchRecord;
  /** RELEASED when Paystack settled inline, PENDING while it is in flight. */
  status: string;
  reason: string;
};

/**
 * Sends what a landlord is owed through Paystack, in one batch. The claim on
 * the entries happens before the transfer: a row that is already `PROCESSING`
 * cannot be claimed by a second run, so a double-click cannot pay twice, and a
 * refused transfer returns the rows through `failHostelPayoutBatch`.
 */
export async function sendHostelPayoutBatch(input: { landlordId: string; note?: unknown; actor: string }): Promise<HostelPayoutSendResult> {
  await ensureHostelPayoutTables();
  const landlordId = String(input.landlordId || "").trim();
  const actor = String(input.actor || "").trim() || "system:payouts";
  const note = String(input.note || "").trim().slice(0, 300);
  if (!landlordId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord to pay.", 400);
  const landlord = await getHostelLandlord(landlordId);
  if (landlord.status !== "ACTIVE") {
    throw new CampusEngineError("INVALID_STATE", "Reactivate the landlord account before sending a payout.", 409);
  }
  const account = await getHostelPayoutAccount(landlordId);
  if (!account.ready) {
    throw new CampusEngineError("INVALID_STATE", "The landlord has not saved a payout account yet.", 409);
  }
  const debt = await hostelPayoutDebt(landlordId);
  if (debt > 0) {
    throw new CampusEngineError("INVALID_STATE", "A refund after a payout left this landlord in debt. Settle it before sending another transfer.", 409);
  }
  const now = new Date();
  const stamp = now.toISOString();
  const inflight = rowsToObjects(await turso(
    "SELECT id FROM hostel_payout_batches WHERE landlord_id = ? AND status = 'PENDING' LIMIT 1",
    [landlordId],
  ))[0];
  if (inflight) {
    throw new CampusEngineError("INVALID_STATE", "A transfer for this landlord is still in flight. Reconcile it before sending another.", 409);
  }
  const eligible = rowsToObjects(await turso(
    "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM hostel_payouts WHERE landlord_id = ? AND status = 'ACCRUED' AND release_after <= ?",
    [landlordId, stamp],
  ))[0];
  const eligibleCount = Number(eligible?.entry_count || 0);
  if (!eligibleCount) {
    throw new CampusEngineError("INVALID_STATE", "No hostel payout is ready yet: an entry releases three days before the academic year starts.", 409);
  }
  if (eligibleCount > HOSTEL_PAYOUT_BATCH_MAX_ENTRIES) {
    throw new CampusEngineError("INVALID_STATE", "More entries are ready than one batch should carry. Send them in smaller batches.", 409);
  }

  // The address is resolved before anything is written: an unverified landlord
  // or an unreachable Paystack must not leave a batch holding the entries.
  let recipient: { recipientCode: string };
  try {
    recipient = await ensureHostelRecipient(landlordId, { actor, landlord });
  } catch (error) {
    if (error instanceof CampusEngineError) throw error;
    throw new CampusEngineError("ENGINE_ERROR", `Paystack could not be reached to address the transfer: ${error instanceof Error ? error.message : "unknown"}`, 502);
  }

  const batchId = crypto.randomUUID();
  const reference = `UMX-HOSTEL-${batchId}`;
  // The batch row comes first so the claim below has somewhere to point, and it
  // is removed again if the claim wins nothing.
  await turso(
    `INSERT INTO hostel_payout_batches (id,landlord_id,total_amount,entry_count,transfer_reference,note,created_by,mode,status,initiated_at,created_at,updated_at)
     VALUES (?,?,0,0,?,?,?,'AUTO','PENDING',?,?,?)`,
    [batchId, landlordId, reference, note, actor, stamp, stamp, stamp],
  );
  await turso(
    `UPDATE hostel_payouts SET status = 'PROCESSING', batch_id = ?, transfer_reference = ?, updated_at = ?
     WHERE landlord_id = ? AND status = 'ACCRUED' AND release_after <= ?`,
    [batchId, reference, stamp, landlordId, stamp],
  );
  const claimed = rowsToObjects(await turso(
    "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM hostel_payouts WHERE batch_id = ?",
    [batchId],
  ))[0];
  const claimedCount = Number(claimed?.entry_count || 0);
  const claimedAmount = Number(claimed?.total_amount || 0);
  if (!claimedCount || !claimedAmount) {
    await turso("DELETE FROM hostel_payout_batches WHERE id = ?", [batchId]).catch(() => undefined);
    throw new CampusEngineError("CONFLICT", "Another payout just claimed those entries. Reload the statement.", 409);
  }

  try {
    const transfer = await initiatePaystackTransfer({
      amount: claimedAmount,
      recipientCode: recipient.recipientCode,
      reference,
      reason: "UMaTeXPRESS hostel earnings",
    });
    const settled = transfer.status === "SUCCESS";
    const failed = transfer.status === "FAILED" || transfer.status === "REVERSED";
    await turso(
      "UPDATE hostel_payout_batches SET total_amount=?,entry_count=?,transfer_code=?,recipient_code=?,status=?,reason=?,updated_at=? WHERE id=?",
      [claimedAmount, claimedCount, transfer.transferCode, recipient.recipientCode, settled ? "RELEASED" : failed ? "FAILED" : "PENDING", transfer.reason, stamp, batchId],
    );
    if (settled) await settleHostelPayoutBatch({ batchId, stamp, actor });
    if (failed) await failHostelPayoutBatch({ batchId, reason: transfer.reason || transfer.rawStatus || "TRANSFER_FAILED", stamp });
    await consoleAudit({
      actor,
      action: settled ? "HOSTEL_PAYOUT_SENT" : "HOSTEL_PAYOUT_TRANSFER_INITIATED",
      targetType: "hostel_landlord",
      targetReference: landlordId,
      details: { batchId, reference, totalAmount: claimedAmount, entryCount: claimedCount, status: transfer.status },
    }).catch(() => undefined);
    const saved = rowsToObjects(await turso(`SELECT * FROM hostel_payout_batches WHERE id = ? LIMIT 1`, [batchId]))[0];
    return {
      batch: batchView(saved ?? { id: batchId, landlord_id: landlordId, total_amount: claimedAmount, entry_count: claimedCount, transfer_reference: reference, note, created_by: actor, created_at: stamp }),
      status: settled ? "RELEASED" : failed ? "FAILED" : "PENDING",
      reason: transfer.reason,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    await failHostelPayoutBatch({ batchId, reason, stamp }).catch(() => undefined);
    logEvent("error", "hostel_payout_transfer_failed", { landlordId, batchId, reason });
    throw new CampusEngineError("ENGINE_ERROR", `Paystack refused the transfer: ${reason}`, 502);
  }
}

export type HostelPayoutReconcileSummary = {
  scanned: number;
  settled: number;
  failed: number;
  stillPending: number;
};

/**
 * The safety net for a webhook that never arrived. Only batches still marked
 * pending are looked at, and only after the wait, so the job cannot race the
 * send it is checking on.
 */
export async function runHostelPayoutReconcileJob(options: { limit?: number; now?: Date } = {}): Promise<HostelPayoutReconcileSummary> {
  const summary: HostelPayoutReconcileSummary = { scanned: 0, settled: 0, failed: 0, stillPending: 0 };
  await ensureHostelPayoutTables();
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - HOSTEL_PAYOUT_RECONCILE_WAIT_MS).toISOString();
  const limit = Math.max(1, Math.min(HOSTEL_PAYOUT_RECONCILE_LIMIT, Math.round(Number(options.limit) || HOSTEL_PAYOUT_RECONCILE_LIMIT)));
  const batches = rowsToObjects(await turso(
    `SELECT id,COALESCE(transfer_reference,'') AS transfer_reference,COALESCE(created_by,'') AS created_by
     FROM hostel_payout_batches
     WHERE status='PENDING' AND mode='AUTO' AND COALESCE(initiated_at,created_at) <= ?
     ORDER BY created_at ASC LIMIT ?`,
    [cutoff, limit],
  ));
  summary.scanned = batches.length;
  for (const batch of batches) {
    const batchId = String(batch.id);
    const reference = String(batch.transfer_reference || "");
    if (!reference) { summary.stillPending += 1; continue; }
    try {
      const transfer = await verifyPaystackTransfer(reference);
      if (transfer.status === "SUCCESS") {
        await settleHostelPayoutBatch({ batchId, stamp, actor: String(batch.created_by || "system:payouts") });
        summary.settled += 1;
      } else if (transfer.status === "FAILED" || transfer.status === "REVERSED") {
        await failHostelPayoutBatch({ batchId, reason: transfer.reason || transfer.rawStatus || "TRANSFER_NOT_SENT", stamp });
        summary.failed += 1;
      } else {
        summary.stillPending += 1;
      }
    } catch (error) {
      // Left pending on purpose: a verify that could not run says nothing
      // about the transfer, and marking it failed would invite a second send.
      logEvent("warn", "hostel_payout_reconcile_deferred", { batchId, reason: error instanceof Error ? error.message : "unknown" });
      summary.stillPending += 1;
    }
  }
  if (summary.settled || summary.failed) logEvent("info", "hostel_payout_reconcile_ran", summary);
  return summary;
}

/** The cron path: send every landlord who is due, unless the switch is off. */
export async function runHostelPayoutReleaseJob(options: { limit?: number; now?: Date; actor?: string } = {}) {
  const summary = { considered: 0, sent: 0, released: 0, pending: 0, skipped: [] as { landlordId: string; reason: string }[], failed: [] as { landlordId: string; reason: string }[], status: "RAN", reason: "" };
  const manual = Boolean(options.actor);
  if (!manual && !(await hostelPayoutAutoEnabled())) {
    return { ...summary, status: "SKIPPED", reason: "AUTO_DISABLED" };
  }
  await ensureHostelPayoutTables();
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const limit = Math.max(1, Math.min(10, Math.round(Number(options.limit) || 4)));
  const candidates = rowsToObjects(await turso(
    `SELECT p.landlord_id, MIN(p.release_after) AS oldest
     FROM hostel_payouts p
     WHERE p.status = 'ACCRUED' AND COALESCE(p.batch_id,'') = '' AND p.release_after <= ?
       AND NOT EXISTS (SELECT 1 FROM hostel_payout_batches b WHERE b.landlord_id = p.landlord_id AND b.status = 'PENDING')
     GROUP BY p.landlord_id ORDER BY oldest ASC LIMIT ?`,
    [stamp, limit],
  ));
  summary.considered = candidates.length;
  for (const candidate of candidates) {
    const landlordId = String(candidate.landlord_id || "");
    if (!landlordId) continue;
    try {
      const result = await sendHostelPayoutBatch({ landlordId, note: "Automatic release", actor: String(options.actor || "system:payouts") });
      summary.sent += 1;
      if (result.status === "RELEASED") summary.released += 1; else summary.pending += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      summary.failed.push({ landlordId, reason });
      logEvent("error", "hostel_payout_release_failed", { landlordId, reason });
    }
  }
  return summary;
}

/**
 * Transfer webhooks. The reference is ours, so it is what the batch is found
 * by; the transfer code is the fallback for a delivery that arrives with only
 * Paystack's own identifier.
 */
export async function applyHostelPaystackTransferEvent(input: { event: string; data: Record<string, unknown> }) {
  await ensureHostelPayoutTables();
  const reference = String(input.data.reference || "").trim();
  const transferCode = String(input.data.transfer_code || "").trim();
  if (!reference && !transferCode) return { handled: false, reason: "REFERENCE_REQUIRED" };
  const batch = rowsToObjects(await turso(
    `SELECT id,COALESCE(status,'') AS status,COALESCE(created_by,'') AS created_by FROM hostel_payout_batches
     WHERE (transfer_reference <> '' AND transfer_reference = ?) OR (transfer_code <> '' AND transfer_code = ?)
     ORDER BY created_at DESC LIMIT 1`,
    [reference, transferCode],
  ))[0];
  if (!batch) return { handled: false, reason: "BATCH_NOT_FOUND" };
  const batchId = String(batch.id);
  if (String(batch.status) !== "PENDING") return { handled: true, reason: "ALREADY_SETTLED" };
  const stamp = new Date().toISOString();
  const status = input.event === "transfer.reversed"
    ? "REVERSED"
    : input.event === "transfer.failed"
      ? "FAILED"
      : input.event === "transfer.success"
        ? "SUCCESS"
        : "";
  if (status === "SUCCESS") {
    await settleHostelPayoutBatch({ batchId, stamp, actor: String(batch.created_by || "system:payouts") });
    return { handled: true, status: "RELEASED" };
  }
  if (status === "FAILED" || status === "REVERSED") {
    await failHostelPayoutBatch({ batchId, reason: String(input.data.reason || input.data.gateway_response || input.event || status).slice(0, 200), stamp });
    return { handled: true, status: "RETURNED_TO_LEDGER" };
  }
  return { handled: true, status: "PENDING" };
}
