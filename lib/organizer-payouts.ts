import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { logEvent } from "@/lib/observability";
import { createPaystackRecipient, fetchPaystackBalance, finalizePaystackTransfer, getPaymentProviderRuntime, initiatePaystackTransfer, normalizeTransferStatus, verifyPaystackTransfer } from "@/lib/paystack";
import { isPayoutMethod, recipientTypeFor, type PayoutMethod } from "@/lib/paystack-banks";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { openSecret } from "@/lib/secret-box";
import { ensureBookingsTable, ensurePaymentsTable, isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * The money ledger for vacationRide organizers.
 *
 * One row per confirmed booking, written at confirmation time. Amounts are
 * pesewas and append-only: a release or a reversal changes `status` and the
 * timestamps, never the gross, the commission or the net. That is what makes
 * the statement reconcile to the bookings behind it.
 *
 * Phase 4 records payouts; an administrator makes the transfer and records the
 * reference. Phase 5 executes them: `runPayoutReleaseJob` addresses a Paystack
 * transfer to the organizer's recipient, and `runPayoutReconcileJob` settles
 * whatever the webhook did not. Both write the same ledger, so a manual batch
 * and an automatic one are the same fact recorded twice.
 */

/**
 * `PROCESSING` is a transfer that has left for Paystack and has not come back
 * yet. It is deliberately not `RELEASED`: money is only released once Paystack
 * says it arrived, and an entry that is merely in flight must not be released
 * a second time.
 */
export const PAYOUT_STATUSES = ["ACCRUED", "PROCESSING", "RELEASED", "REVERSED", "FAILED"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const PAYOUTS_SCHEMA_VERSION = "2026-09-18.2";
const DEFAULT_COMMISSION_BPS = 300;
const MAX_BATCH_ENTRIES = 500;
/** A transfer that has failed this many times stops retrying and asks for a human. */
const MAX_TRANSFER_ATTEMPTS = 3;
const MAX_RELEASE_CANDIDATES = 4;
const MAX_RECONCILE_BATCHES = 5;
/** Paystack charges per transfer, and it comes out of the same balance. */
const DEFAULT_TRANSFER_FEE_PESEWAS = 800;
/**
 * A batch held because Paystack asked for a one-time password. It rides in
 * `reason` because it is exactly that: why the batch is still pending. The
 * console reads it back as `awaitingOtp` rather than matching the string.
 */
const AWAITING_OTP_REASON = "AWAITING_OTP";

const PAYOUTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS organizer_payouts (
    id TEXT PRIMARY KEY,
    organizer_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    booking_reference TEXT NOT NULL DEFAULT '',
    trip_id TEXT NOT NULL DEFAULT '',
    gross_amount INTEGER NOT NULL DEFAULT 0,
    commission_amount INTEGER NOT NULL DEFAULT 0,
    net_amount INTEGER NOT NULL DEFAULT 0,
    commission_bps INTEGER NOT NULL DEFAULT 300,
    release_after TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACCRUED',
    batch_id TEXT NOT NULL DEFAULT '',
    transfer_reference TEXT NOT NULL DEFAULT '',
    payout_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    released_at TEXT,
    transferred_at TEXT,
    reversed_at TEXT,
    reversed_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // One row per booking is the idempotency guarantee, enforced by the database
  // rather than by the order two payment paths happen to run in.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_organizer_payouts_booking ON organizer_payouts(booking_id)",
  "CREATE INDEX IF NOT EXISTS idx_organizer_payouts_organizer ON organizer_payouts(organizer_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_organizer_payouts_due ON organizer_payouts(status, release_after)",
  `CREATE TABLE IF NOT EXISTS organizer_payout_batches (
    id TEXT PRIMARY KEY,
    organizer_id TEXT NOT NULL,
    total_amount INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0,
    transfer_reference TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'MANUAL',
    status TEXT NOT NULL DEFAULT 'RECORDED',
    transfer_code TEXT NOT NULL DEFAULT '',
    recipient_code TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    initiated_at TEXT,
    settled_at TEXT,
    updated_at TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_organizer_payout_batches ON organizer_payout_batches(organizer_id, created_at)",
  // Transfer execution, added after the ledger shipped: an entry that is in
  // flight, and the attempts that failed before it got there.
  "ALTER TABLE organizer_payouts ADD COLUMN payout_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE organizer_payouts ADD COLUMN last_error TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE organizer_payout_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'MANUAL'",
  "ALTER TABLE organizer_payout_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'RECORDED'",
  "ALTER TABLE organizer_payout_batches ADD COLUMN transfer_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE organizer_payout_batches ADD COLUMN recipient_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE organizer_payout_batches ADD COLUMN reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE organizer_payout_batches ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE organizer_payout_batches ADD COLUMN initiated_at TEXT",
  "ALTER TABLE organizer_payout_batches ADD COLUMN settled_at TEXT",
  "ALTER TABLE organizer_payout_batches ADD COLUMN updated_at TEXT",
  "CREATE INDEX IF NOT EXISTS idx_organizer_payout_batches_status ON organizer_payout_batches(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_organizer_payouts_batch ON organizer_payouts(batch_id)",
];

let payoutsTableReady: Promise<void> | null = null;

export function ensurePayoutTables() {
  payoutsTableReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "organizerPayouts",
    version: PAYOUTS_SCHEMA_VERSION,
    statements: PAYOUTS_SCHEMA_STATEMENTS,
  }).catch((error: unknown) => {
    payoutsTableReady = null;
    throw error;
  });
  return payoutsTableReady;
}

/**
 * A booking's earnings become payable 24 hours after the booking was paid.
 *
 * The day is not about the trip: it is the window in which a mistaken or
 * duplicated payment can be reversed before any money moves, and it is long
 * enough for the charge to settle. The release job still refuses to send
 * against funds Paystack has not settled, so the two gates are independent.
 * A timestamp that cannot be read falls back to the moment the entry is
 * written, which pays at the same pace rather than never.
 */
export function releaseAfterFor(paidAt: unknown, now = new Date()) {
  const paid = Date.parse(String(paidAt || "").trim());
  const anchor = Number.isNaN(paid) ? now.getTime() : paid;
  return new Date(anchor + 24 * 60 * 60_000).toISOString();
}

/** `round(gross * bps / 10000)`, with the net derived from the two so the split can never be a pesewa out. */
export function splitCommission(gross: number, commissionBps: number) {
  const safeGross = Math.max(0, Math.round(Number(gross) || 0));
  const safeBps = Math.max(0, Math.min(10_000, Math.round(Number(commissionBps) || 0)));
  const commission = Math.round((safeGross * safeBps) / 10_000);
  return { gross: safeGross, commission, net: safeGross - commission };
}

type AccrualInput = {
  booking_id: string;
  reference: string;
  trip_id: string;
  organizer_id: string;
  /** When the booking was paid: the anchor the 24-hour release gate counts from. */
  paid_at: string;
  booking_status: string;
  fare_amount: number;
  amount: number;
  commission_bps: number;
};

export type AccrualResult =
  | { status: "ACCRUED" | "ALREADY_ACCRUED"; payoutId: string; organizerId: string; gross: number; commission: number; net: number; releaseAfter: string }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; reason: string };

/**
 * Writes the ledger row for one confirmed booking.
 *
 * This runs on the payment path, straight after a booking is confirmed, so it
 * must never throw: a student's ticket is already paid for by then, and a
 * bookkeeping failure must not turn a successful payment into an error. A
 * failure is logged and left to `backfillAccruals`, which is idempotent.
 */
export async function accrueForBooking(bookingId: string): Promise<AccrualResult> {
  try {
    if (!(await isTursoConfiguredRuntime())) return { status: "SKIPPED", reason: "TURSO_NOT_CONFIGURED" };
    await ensureBookingsTable();
    await ensurePaymentsTable();
    await ensurePayoutTables();

    const row = rowsToObjects(await turso(
      `SELECT b.id AS booking_id, b.reference, b.trip_id, COALESCE(b.organizer_id,'') AS organizer_id,
         b.booking_status,
         COALESCE(b.confirmed_at, p.completed_at, p.created_at, b.created_at) AS paid_at,
         COALESCE(p.fare_amount,0) AS fare_amount, COALESCE(p.amount,0) AS amount,
         COALESCE(o.commission_bps, ${DEFAULT_COMMISSION_BPS}) AS commission_bps
       FROM bookings b
       LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'SUCCESSFUL'
       LEFT JOIN trip_organizers o ON o.id = b.organizer_id
       WHERE b.id = ? LIMIT 1`,
      [bookingId],
    ))[0] as AccrualInput | undefined;

    if (!row) return { status: "SKIPPED", reason: "BOOKING_NOT_FOUND" };
    if (String(row.booking_status) !== "CONFIRMED") return { status: "SKIPPED", reason: "BOOKING_NOT_CONFIRMED" };
    // A platform-owned trip earns the platform: there is nobody to pay.
    if (!String(row.organizer_id || "")) return { status: "SKIPPED", reason: "PLATFORM_OWNED" };

    // The commission base is the fare, never `bookings.amount`, which carries
    // Paystack's charge as a pass-through that the organizer never earned.
    const gross = Number(row.fare_amount || 0) > 0 ? Number(row.fare_amount) : Number(row.amount || 0);
    const split = splitCommission(gross, Number(row.commission_bps || DEFAULT_COMMISSION_BPS));
    const stamp = new Date().toISOString();
    const releaseAfter = releaseAfterFor(row.paid_at, new Date(stamp));
    const payoutId = crypto.randomUUID();

    const insert = await turso(
      `INSERT OR IGNORE INTO organizer_payouts
         (id,organizer_id,booking_id,booking_reference,trip_id,gross_amount,commission_amount,net_amount,commission_bps,release_after,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'ACCRUED',?,?)`,
      [
        payoutId, String(row.organizer_id), String(row.booking_id), String(row.reference || ""), String(row.trip_id || ""),
        split.gross, split.commission, split.net, Number(row.commission_bps) || DEFAULT_COMMISSION_BPS, releaseAfter, stamp, stamp,
      ],
    );
    // The booking carries its own copy of the split, so a later rate or
    // ownership change cannot rewrite what was already earned.
    await turso(
      "UPDATE bookings SET commission_amount = ? WHERE id = ? AND COALESCE(organizer_id,'') <> ''",
      [split.commission, String(row.booking_id)],
    );
    // Zero rows means the unique booking index already held a row: verify and
    // the webhook can both confirm one booking, and only the first accrues.
    const inserted = Number(insert?.affected_row_count ?? 0) > 0;
    return { status: inserted ? "ACCRUED" : "ALREADY_ACCRUED", payoutId, organizerId: String(row.organizer_id), ...split, releaseAfter };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    logEvent("error", "payout_accrual_failed", { bookingId, reason });
    return { status: "FAILED", reason };
  }
}

/**
 * Rebuilds ledger rows that a failed write left behind. Idempotent: the unique
 * booking index means a row that already exists is skipped, so this is safe to
 * run whenever an admin suspects a gap.
 */
export async function backfillAccruals(input: { limit?: number } = {}) {
  await ensureBookingsTable();
  await ensurePayoutTables();
  const limit = Math.max(1, Math.min(20, Math.round(Number(input.limit) || 10)));
  const rows = rowsToObjects(await turso(
    `SELECT b.id FROM bookings b
     WHERE b.booking_status = 'CONFIRMED' AND COALESCE(b.organizer_id,'') <> ''
       AND NOT EXISTS (SELECT 1 FROM organizer_payouts p WHERE p.booking_id = b.id)
     ORDER BY COALESCE(b.confirmed_at,'') DESC LIMIT ?`,
    [limit],
  ));
  let accrued = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await accrueForBooking(String(row.id));
    if (result.status === "ACCRUED") accrued += 1;
    else if (result.status === "FAILED") failed += 1;
    else skipped += 1;
  }
  return { scanned: rows.length, accrued, skipped, failed };
}

export type PayoutTotals = {
  /** Everything earned and not yet paid out: waiting, in flight, or stuck. */
  accrued: number;
  /** Accrued entries whose release gate has passed and can be put in a batch. */
  ready: number;
  released: number;
  reversed: number;
  /** Money already paid out that a refund has taken back. */
  debt: number;
  /** `accrued - debt`: what the organizer is actually owed right now. */
  balance: number;
  entries: number;
};

const EMPTY_TOTALS: PayoutTotals = { accrued: 0, ready: 0, released: 0, reversed: 0, debt: 0, balance: 0, entries: 0 };

function totalsFrom(row: Record<string, unknown> | undefined): PayoutTotals {
  if (!row) return { ...EMPTY_TOTALS };
  const accrued = Number(row.accrued || 0);
  const debt = Number(row.debt || 0);
  return {
    accrued,
    ready: Number(row.ready || 0),
    released: Number(row.released || 0),
    reversed: Number(row.reversed || 0),
    debt,
    balance: accrued - debt,
    entries: Number(row.entries || 0),
  };
}

/**
 * `released_at` is deliberately kept when a released entry is reversed: it is
 * the only evidence that money actually left the platform, and therefore the
 * only reason a reversal creates a debt instead of quietly cancelling a row.
 */
const TOTALS_SQL = `SELECT
  COALESCE(SUM(CASE WHEN status IN ('ACCRUED','PROCESSING','FAILED') THEN net_amount ELSE 0 END),0) AS accrued,
  COALESCE(SUM(CASE WHEN status = 'ACCRUED' AND COALESCE(batch_id,'') = '' AND release_after <= ? THEN net_amount ELSE 0 END),0) AS ready,
  COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN net_amount ELSE 0 END),0) AS released,
  COALESCE(SUM(CASE WHEN status = 'REVERSED' THEN net_amount ELSE 0 END),0) AS reversed,
  COALESCE(SUM(CASE WHEN status = 'REVERSED' AND COALESCE(released_at,'') <> '' THEN net_amount ELSE 0 END),0) AS debt,
  COUNT(*) AS entries
  FROM organizer_payouts WHERE organizer_id = ?`;

export async function organizerTotals(organizerId: string, now = new Date()): Promise<PayoutTotals> {
  await ensurePayoutTables();
  const row = rowsToObjects(await turso(TOTALS_SQL, [now.toISOString(), organizerId]))[0];
  return totalsFrom(row);
}

export type PayoutOrganizerSummary = {
  organizerId: string;
  name: string;
  organization: string;
  status: string;
  kycStatus: string;
  commissionBps: number;
  totals: PayoutTotals;
};

/** The admin overview: every approved organizer with the money owed to them. */
export async function listPayoutOrganizers() {
  await ensurePayoutTables();
  const now = new Date().toISOString();
  const grouped = rowsToObjects(await turso(
    `SELECT organizer_id,
       COALESCE(SUM(CASE WHEN status IN ('ACCRUED','PROCESSING','FAILED') THEN net_amount ELSE 0 END),0) AS accrued,
       COALESCE(SUM(CASE WHEN status = 'ACCRUED' AND COALESCE(batch_id,'') = '' AND release_after <= ? THEN net_amount ELSE 0 END),0) AS ready,
       COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN net_amount ELSE 0 END),0) AS released,
       COALESCE(SUM(CASE WHEN status = 'REVERSED' THEN net_amount ELSE 0 END),0) AS reversed,
       COALESCE(SUM(CASE WHEN status = 'REVERSED' AND COALESCE(released_at,'') <> '' THEN net_amount ELSE 0 END),0) AS debt,
       COUNT(*) AS entries
     FROM organizer_payouts GROUP BY organizer_id`,
    [now],
  ));
  const byOrganizer = new Map(grouped.map((row) => [String(row.organizer_id), row]));

  // Loaded on demand so the payment-confirmation path (which only calls
  // `accrueForBooking`) does not pull the organizer and console-auth modules in.
  const { listOrganizers } = await import("@/lib/organizers");
  const organizers = await listOrganizers();
  const seen = new Set<string>();
  const rows: PayoutOrganizerSummary[] = organizers.map((organizer) => {
    seen.add(organizer.id);
    return {
      organizerId: organizer.id,
      name: organizer.name,
      organization: organizer.organization,
      status: organizer.status,
      kycStatus: organizer.kycStatus,
      commissionBps: organizer.commissionBps,
      totals: totalsFrom(byOrganizer.get(organizer.id)),
    };
  });
  // A payout row whose organizer record has gone must still be visible, or the
  // money it represents would vanish from the console.
  for (const [organizerId, row] of byOrganizer) {
    if (seen.has(organizerId)) continue;
    rows.push({ organizerId, name: organizerId, organization: "", status: "UNKNOWN", kycStatus: "UNKNOWN", commissionBps: DEFAULT_COMMISSION_BPS, totals: totalsFrom(row) });
  }
  return rows.sort((left, right) => right.totals.balance - left.totals.balance);
}

export type PayoutEntry = {
  id: string;
  bookingId: string;
  bookingReference: string;
  tripId: string;
  title: string;
  from: string;
  to: string;
  grossAmount: number;
  commissionAmount: number;
  netAmount: number;
  commissionBps: number;
  releaseAfter: string;
  status: string;
  transferReference: string;
  attempts: number;
  lastError: string;
  releasedAt: string;
  reversedAt: string;
  reversedReason: string;
  createdAt: string;
};

export type PayoutBatch = {
  id: string;
  totalAmount: number;
  entryCount: number;
  transferReference: string;
  mode: string;
  status: string;
  transferCode: string;
  reason: string;
  attempts: number;
  /** Paystack is holding this transfer until someone supplies a one-time password. */
  awaitingOtp: boolean;
  note: string;
  createdBy: string;
  initiatedAt: string;
  settledAt: string;
  createdAt: string;
};

/** One organizer's ledger, newest first. Organizers only ever read their own. */
export async function organizerStatement(organizerId: string) {
  await ensurePayoutTables();
  const rows = rowsToObjects(await turso(
    `SELECT p.id,p.booking_id,p.booking_reference,p.trip_id,
       COALESCE(t.title,'') AS title,COALESCE(t.route_from,'') AS route_from,COALESCE(t.route_to,'') AS route_to,
       p.gross_amount,p.commission_amount,p.net_amount,p.commission_bps,p.release_after,p.status,
       COALESCE(p.transfer_reference,'') AS transfer_reference,COALESCE(p.payout_attempts,0) AS payout_attempts,
       COALESCE(p.last_error,'') AS last_error,COALESCE(p.released_at,'') AS released_at,
       COALESCE(p.reversed_at,'') AS reversed_at,COALESCE(p.reversed_reason,'') AS reversed_reason,p.created_at
     FROM organizer_payouts p LEFT JOIN scheduled_trips t ON t.id = p.trip_id
     WHERE p.organizer_id = ? ORDER BY p.created_at DESC LIMIT 200`,
    [organizerId],
  ));
  const batches = rowsToObjects(await turso(
    `SELECT id,total_amount,entry_count,COALESCE(transfer_reference,'') AS transfer_reference,COALESCE(note,'') AS note,
       COALESCE(mode,'MANUAL') AS mode,COALESCE(status,'RECORDED') AS status,COALESCE(transfer_code,'') AS transfer_code,
       COALESCE(reason,'') AS reason,COALESCE(attempts,0) AS attempts,
       COALESCE(initiated_at,'') AS initiated_at,COALESCE(settled_at,'') AS settled_at,
       COALESCE(created_by,'') AS created_by,created_at
     FROM organizer_payout_batches WHERE organizer_id = ? ORDER BY created_at DESC LIMIT 50`,
    [organizerId],
  ));
  return {
    totals: await organizerTotals(organizerId),
    entries: rows.map((row): PayoutEntry => ({
      id: String(row.id),
      bookingId: String(row.booking_id),
      bookingReference: String(row.booking_reference || ""),
      tripId: String(row.trip_id || ""),
      title: String(row.title || ""),
      from: String(row.route_from || ""),
      to: String(row.route_to || ""),
      grossAmount: Number(row.gross_amount || 0),
      commissionAmount: Number(row.commission_amount || 0),
      netAmount: Number(row.net_amount || 0),
      commissionBps: Number(row.commission_bps || 0),
      releaseAfter: String(row.release_after || ""),
      status: String(row.status || "ACCRUED"),
      transferReference: String(row.transfer_reference || ""),
      attempts: Number(row.payout_attempts || 0),
      lastError: String(row.last_error || ""),
      releasedAt: String(row.released_at || ""),
      reversedAt: String(row.reversed_at || ""),
      reversedReason: String(row.reversed_reason || ""),
      createdAt: String(row.created_at || ""),
    })),
    batches: batches.map((row): PayoutBatch => ({
      id: String(row.id),
      totalAmount: Number(row.total_amount || 0),
      entryCount: Number(row.entry_count || 0),
      transferReference: String(row.transfer_reference || ""),
      mode: String(row.mode || "MANUAL"),
      status: String(row.status || "RECORDED"),
      transferCode: String(row.transfer_code || ""),
      reason: String(row.reason || ""),
      attempts: Number(row.attempts || 0),
      awaitingOtp: String(row.reason || "") === AWAITING_OTP_REASON,
      note: String(row.note || ""),
      createdBy: String(row.created_by || ""),
      initiatedAt: String(row.initiated_at || ""),
      settledAt: String(row.settled_at || ""),
      createdAt: String(row.created_at || ""),
    })),
  };
}

/**
 * Records a payout the administrator has already made by hand: the entries it
 * covers move to `RELEASED` together, carrying the transfer reference they were
 * paid under. Phase 5 replaces the human transfer with the Paystack call, not
 * with a different ledger.
 */
export async function recordPayoutBatch(input: {
  organizerId: string;
  reference?: unknown;
  note?: unknown;
  actor: string;
}) {
  await ensurePayoutTables();
  const organizerId = String(input.organizerId || "").trim();
  const reference = String(input.reference || "").trim();
  const note = String(input.note || "").trim().slice(0, 300);
  const actor = String(input.actor || "").trim();
  if (!organizerId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an organizer.", 400);
  if (reference.length < 3 || reference.length > 80) {
    throw new CampusEngineError("VALIDATION_ERROR", "Record the transfer reference you were given (3-80 characters).", 400);
  }

  const { getOrganizer } = await import("@/lib/organizers");
  const organizer = await getOrganizer(organizerId);
  if (!organizer) throw new CampusEngineError("NOT_FOUND", "That organizer was not found.", 404);
  if (organizer.status !== "APPROVED") {
    throw new CampusEngineError("INVALID_STATE", "Reinstate the organizer before recording a payout.", 409);
  }
  // KYC is the money gate. A payout to an unverified organizer is exactly what
  // the gate exists to stop, so it blocks the batch rather than one entry.
  if (organizer.kycStatus !== "VERIFIED") {
    throw new CampusEngineError("INVALID_STATE", "Verify the organizer's KYC before recording a payout.", 409);
  }

  const now = new Date();
  const stamp = now.toISOString();
  const totals = await organizerTotals(organizerId, now);
  if (totals.debt > 0) {
    throw new CampusEngineError("INVALID_STATE", "A refund after a payout left this balance in debt. Settle it before the next payout.", 409);
  }
  // The count and the total come from the same predicate the release uses, so
  // the size cap is enforced before anything is marked released.
  const eligible = rowsToObjects(await turso(
    "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM organizer_payouts WHERE organizer_id = ? AND status = 'ACCRUED' AND release_after <= ?",
    [organizerId, stamp],
  ))[0];
  const eligibleCount = Number(eligible?.entry_count || 0);
  if (!eligibleCount) {
    throw new CampusEngineError("INVALID_STATE", "No payout is ready yet: entries become ready 24 hours after the booking was paid.", 409);
  }
  if (eligibleCount > MAX_BATCH_ENTRIES) {
    throw new CampusEngineError("INVALID_STATE", "More entries are ready than one batch should carry. Record them in smaller batches.", 409);
  }

  const batchId = crypto.randomUUID();
  await turso(
    "INSERT INTO organizer_payout_batches (id,organizer_id,total_amount,entry_count,transfer_reference,note,created_by,created_at) VALUES (?,?,0,0,?,?,?,?)",
    [batchId, organizerId, reference, note, actor, stamp],
  );
  // The status check is part of the UPDATE, so two admins recording the same
  // batch cannot release one entry twice.
  await turso(
    `UPDATE organizer_payouts SET status = 'RELEASED', batch_id = ?, transfer_reference = ?, released_at = ?, transferred_at = ?, updated_at = ?
     WHERE organizer_id = ? AND status = 'ACCRUED' AND release_after <= ?`,
    [batchId, reference, stamp, stamp, stamp, organizerId, stamp],
  );
  const claimed = rowsToObjects(await turso(
    "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM organizer_payouts WHERE batch_id = ?",
    [batchId],
  ))[0];
  const entryCount = Number(claimed?.entry_count || 0);
  const totalAmount = Number(claimed?.total_amount || 0);

  if (!entryCount) {
    await turso("DELETE FROM organizer_payout_batches WHERE id = ?", [batchId]).catch(() => undefined);
    throw new CampusEngineError("INVALID_STATE", "Another payout just recorded those entries. Reload the statement.", 409);
  }

  await turso(
    "UPDATE organizer_payout_batches SET total_amount = ?, entry_count = ? WHERE id = ?",
    [totalAmount, entryCount, batchId],
  );
  await consoleAudit({
    actor,
    action: "ORGANIZER_PAYOUT_RECORDED",
    targetType: "trip_organizer",
    targetReference: organizerId,
    details: { batchId, reference, totalAmount, entryCount },
  });
  return { id: batchId, organizerId, totalAmount, entryCount, transferReference: reference, note, createdAt: stamp };
}

/**
 * A cancelled booking stops earning. Money that never left the platform is
 * merely un-earned; money that did is a debt the next payout absorbs, which is
 * why `released_at` is read before it is cleared.
 */
export async function reversePayoutForBooking(input: { bookingId: string; reason?: string; actor?: string }) {
  await ensurePayoutTables();
  const bookingId = String(input.bookingId || "").trim();
  if (!bookingId) return { reversed: false, reason: "BOOKING_REQUIRED" };
  const row = rowsToObjects(await turso(
    "SELECT id,organizer_id,status,COALESCE(released_at,'') AS released_at FROM organizer_payouts WHERE booking_id = ? LIMIT 1",
    [bookingId],
  ))[0];
  if (!row) return { reversed: false, reason: "NO_LEDGER_ENTRY" };
  if (String(row.status) === "REVERSED") return { reversed: false, reason: "ALREADY_REVERSED" };

  const wasReleased = Boolean(String(row.released_at || "")) || String(row.status) === "RELEASED";
  const stamp = new Date().toISOString();
  await turso(
    `UPDATE organizer_payouts SET status = 'REVERSED', reversed_at = ?, reversed_reason = ?, updated_at = ?
     WHERE booking_id = ? AND status <> 'REVERSED'`,
    [stamp, String(input.reason || "").trim().slice(0, 200), stamp, bookingId],
  );
  if (input.actor) {
    await consoleAudit({
      actor: input.actor,
      action: "ORGANIZER_PAYOUT_REVERSED",
      targetType: "trip_organizer",
      targetReference: String(row.organizer_id || ""),
      details: { bookingId, reason: String(input.reason || ""), debtCreated: wasReleased },
    }).catch(() => undefined);
  }
  return { reversed: true, debtCreated: wasReleased };
}

/* ------------------------------------------------------------------ *
 * Phase 5: executing the transfer.
 *
 * The ledger above decides who is owed what. This section decides when it is
 * safe to send, and records the result. Two rules shape all of it:
 *
 *   1. An entry is only ever in one place. A conditional UPDATE claims the
 *      rows it moves, so a cron run overlapping an administrator's manual run
 *      cannot pay the same booking twice.
 *   2. Nothing is released until Paystack says the money arrived. In flight is
 *      its own state, and the reconcile job — not the send — is what settles.
 * ------------------------------------------------------------------ */

async function envNumber(name: string, fallback: number) {
  const { envValue } = await import("@/lib/runtime-env");
  const raw = Number((await envValue(name)).trim());
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : fallback;
}

/**
 * Unattended transfers are opt-in. The switch exists so that a deployment can
 * hold the ledger and the statements without a cron ever moving money; an
 * administrator clicking "run now" is attended and is not gated by it. The
 * console's Platform settings holds the override, and `PAYOUT_AUTO_ENABLED`
 * stays as the fallback for a deployment that never opens that page.
 */
export async function payoutAutoEnabled() {
  return platformSettingEnabled("organizer_payout_auto");
}

export async function payoutTransferFee() {
  return envNumber("PAYOUT_TRANSFER_FEE_PESEWAS", DEFAULT_TRANSFER_FEE_PESEWAS);
}

/**
 * The floor below which a transfer is not worth making.
 *
 * A Paystack transfer costs a flat fee whatever it carries, so sending a few
 * pesewas of earnings can cost more than it delivers. Anything under this
 * stays on the ledger and is sent with the next batch that clears it: the
 * organizer waits longer and keeps more. It is a console setting, so the
 * policy can move without a deploy, and `PAYOUT_MIN_AMOUNT_PESEWAS` is the
 * fallback for a deployment that never opens the page.
 */
export async function payoutMinimumAmount() {
  return platformSettingNumber("organizer_payout_min_amount");
}

/** What Paystack says can be paid right now. Null when Paystack cannot be reached. */
export async function platformPayoutBalance() {
  try {
    const { envValue } = await import("@/lib/runtime-env");
    const currency = (await envValue("PAYSTACK_CURRENCY")) || "GHS";
    return await fetchPaystackBalance(currency);
  } catch (error) {
    logEvent("warn", "payout_balance_unavailable", { reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

type OrganizerPayee = {
  status: string;
  kyc_status: string;
  name: string;
  email: string;
  payout_method: string;
  payout_account_name: string;
  payout_account_number: string;
  payout_bank_code: string;
  paystack_recipient_code: string;
};

/**
 * The Paystack address for an organizer, created once and reused. It is
 * rebuilt whenever the account details change, which is why saving new payout
 * details clears the stored code.
 */
export async function ensureOrganizerRecipient(organizerId: string, options: { actor?: string } = {}) {
  const row = rowsToObjects(await turso(
    `SELECT COALESCE(status,'PENDING') AS status,COALESCE(kyc_status,'PENDING') AS kyc_status,
       COALESCE(name,'') AS name,COALESCE(email,'') AS email,COALESCE(payout_method,'') AS payout_method,
       COALESCE(payout_account_name,'') AS payout_account_name,COALESCE(payout_account_number,'') AS payout_account_number,
       COALESCE(payout_bank_code,'') AS payout_bank_code,COALESCE(paystack_recipient_code,'') AS paystack_recipient_code
     FROM trip_organizers WHERE id = ? LIMIT 1`,
    [organizerId],
  ))[0] as OrganizerPayee | undefined;
  if (!row) throw new CampusEngineError("NOT_FOUND", "That organizer was not found.", 404);
  if (String(row.status) !== "APPROVED") {
    throw new CampusEngineError("INVALID_STATE", "This organizer is not approved.", 409);
  }
  if (String(row.kyc_status) !== "VERIFIED") {
    throw new CampusEngineError("INVALID_STATE", "Verify the organizer's KYC before paying them.", 409);
  }
  if (String(row.paystack_recipient_code)) {
    return { recipientCode: String(row.paystack_recipient_code), created: false };
  }
  const method = String(row.payout_method || "").toUpperCase();
  if (!isPayoutMethod(method)) {
    throw new CampusEngineError("INVALID_STATE", "The organizer has not recorded where to be paid.", 409);
  }
  const bankCode = String(row.payout_bank_code || "").trim();
  if (!bankCode) {
    throw new CampusEngineError("INVALID_STATE", "The organizer's bank or network is missing, so a transfer cannot be addressed.", 409);
  }
  const accountNumber = await openSecret(row.payout_account_number);
  if (!accountNumber) {
    // Sealed with a key that is no longer held: only the organizer can fix it
    // by saving the details again.
    throw new CampusEngineError("INVALID_STATE", "The organizer's account number cannot be read. Ask them to save it again.", 409);
  }
  const { envValue } = await import("@/lib/runtime-env");
  const currency = (await envValue("PAYSTACK_CURRENCY")) || "GHS";
  const created = await createPaystackRecipient({
    type: recipientTypeFor(method as PayoutMethod),
    name: String(row.payout_account_name || row.name || "Organizer"),
    accountNumber,
    bankCode,
    currency,
    email: String(row.email || "") || undefined,
    description: `UMaTeXPRESS organizer ${organizerId}`,
  });
  await turso(
    "UPDATE trip_organizers SET paystack_recipient_code=?,updated_at=? WHERE id=?",
    [created.recipientCode, new Date().toISOString(), organizerId],
  );
  await consoleAudit({
    actor: String(options.actor || "system:payouts"),
    action: "ORGANIZER_RECIPIENT_CREATED",
    targetType: "trip_organizer",
    targetReference: organizerId,
    // The recipient code is an address, not a secret, but the account number
    // that produced it never reaches the audit trail.
    details: { recipientCode: created.recipientCode, method, bankCode },
  }).catch(() => undefined);
  return { recipientCode: created.recipientCode, created: true };
}

export type PayoutReleaseSummary = {
  status: "RAN" | "SKIPPED";
  reason?: string;
  considered: number;
  transferred: number;
  inFlight: number;
  skipped: Array<{ organizerId: string; reason: string }>;
  failed: Array<{ organizerId: string; reason: string }>;
  totalTransferred: number;
  balance: number | null;
  /** The floor a balance had to clear to be sent, so a skip can be explained. */
  minimum: number;
};

/**
 * Sends what is due, and only what the settled balance can cover.
 *
 * Paystack settles on its own schedule, so the platform balance — not the sum
 * of what has been collected — is the ceiling. A transfer also costs a fee
 * that comes out of the same balance, so the fee is budgeted per organizer
 * rather than assumed away.
 */
export async function runPayoutReleaseJob(options: { limit?: number; actor?: string; now?: Date } = {}): Promise<PayoutReleaseSummary> {
  const empty: PayoutReleaseSummary = { status: "RAN", considered: 0, transferred: 0, inFlight: 0, skipped: [], failed: [], totalTransferred: 0, balance: null, minimum: 0 };
  if (!(await isTursoConfiguredRuntime())) return { ...empty, status: "SKIPPED", reason: "TURSO_NOT_CONFIGURED" };
  await ensurePayoutTables();
  if ((await getPaymentProviderRuntime()) !== "PAYSTACK") {
    // Money collected by another provider is not in the Paystack balance, so
    // there would be nothing to transfer from.
    return { ...empty, status: "SKIPPED", reason: "PAYMENT_PROVIDER_NOT_PAYSTACK" };
  }
  const minimum = await payoutMinimumAmount();
  empty.minimum = minimum;
  const manual = Boolean(options.actor);
  if (!manual && !(await payoutAutoEnabled())) return { ...empty, status: "SKIPPED", reason: "AUTO_DISABLED" };

  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const limit = Math.max(1, Math.min(MAX_RELEASE_CANDIDATES, Math.round(Number(options.limit) || MAX_RELEASE_CANDIDATES)));
  const fee = await payoutTransferFee();

  // One query decides the queue: due entries, an approved and verified
  // organizer, somewhere to send the money, no standing debt, and no transfer
  // already in flight. Oldest first, so a backlog pays out in the order it was
  // earned.
  const candidates = rowsToObjects(await turso(
    `SELECT p.organizer_id,
       MIN(p.release_after) AS oldest,
       COUNT(*) AS entry_count,
       COALESCE(SUM(p.net_amount),0) AS total_amount,
       COALESCE(o.status,'') AS organizer_status,
       COALESCE(o.kyc_status,'') AS kyc_status,
       COALESCE(o.payout_method,'') AS payout_method,
       COALESCE(o.payout_bank_code,'') AS payout_bank_code
     FROM organizer_payouts p
     LEFT JOIN trip_organizers o ON o.id = p.organizer_id
     WHERE p.status = 'ACCRUED' AND COALESCE(p.batch_id,'') = '' AND p.release_after <= ?
       AND NOT EXISTS (SELECT 1 FROM organizer_payout_batches b WHERE b.organizer_id = p.organizer_id AND b.status = 'PENDING')
       AND NOT EXISTS (SELECT 1 FROM organizer_payouts d WHERE d.organizer_id = p.organizer_id AND d.status = 'REVERSED' AND COALESCE(d.released_at,'') <> '')
     GROUP BY p.organizer_id ORDER BY oldest ASC LIMIT ?`,
    [stamp, limit],
  ));
  empty.considered = candidates.length;
  if (!candidates.length) return empty;

  const balance = await platformPayoutBalance();
  empty.balance = balance ? balance.balance : null;
  let budget = balance ? balance.balance : 0;

  const summary: PayoutReleaseSummary = { ...empty, skipped: [], failed: [] };
  for (const candidate of candidates) {
    const organizerId = String(candidate.organizer_id || "");
    const skip = (reason: string) => { summary.skipped.push({ organizerId, reason }); };
    if (!organizerId) { skip("NO_ORGANIZER"); continue; }
    if (String(candidate.organizer_status) !== "APPROVED") { skip("NOT_APPROVED"); continue; }
    if (String(candidate.kyc_status) !== "VERIFIED") { skip("KYC_NOT_VERIFIED"); continue; }
    if (!isPayoutMethod(String(candidate.payout_method || "")) || !String(candidate.payout_bank_code || "")) { skip("NO_DESTINATION"); continue; }
    const entryCount = Number(candidate.entry_count || 0);
    const amount = Number(candidate.total_amount || 0);
    if (!amount) { skip("NOTHING_DUE"); continue; }
    // Checked before the balance so a balance that cannot cover a transfer
    // does not hide the reason that would still stand if it could.
    if (amount < minimum) { skip("BELOW_MINIMUM"); continue; }
    // A batch this size is a data problem, not a payout: it is far more likely
    // to be a backlog nobody looked at than a single day's earnings.
    if (entryCount > MAX_BATCH_ENTRIES) { skip("TOO_MANY_ENTRIES"); continue; }
    if (!balance) { skip("BALANCE_UNAVAILABLE"); continue; }
    if (amount + fee > budget) { skip("INSUFFICIENT_BALANCE"); continue; }

    const batchId = crypto.randomUUID();
    const reference = `UMX-PAYOUT-${batchId}`;
    try {
      // The batch row comes first so the claim below has somewhere to point,
      // and it is removed again if the claim wins nothing.
      await turso(
        `INSERT INTO organizer_payout_batches
           (id,organizer_id,total_amount,entry_count,transfer_reference,mode,status,attempts,created_by,initiated_at,updated_at,created_at)
         VALUES (?,?,0,0,?,'AUTO','PENDING',1,?,?,?,?)`,
        [batchId, organizerId, reference, String(options.actor || "system:payouts"), stamp, stamp, stamp],
      );
      // The claim: moving the rows is what proves nobody else has them.
      await turso(
        `UPDATE organizer_payouts SET status = 'PROCESSING', batch_id = ?, transfer_reference = ?, updated_at = ?
         WHERE organizer_id = ? AND status = 'ACCRUED' AND COALESCE(batch_id,'') = '' AND release_after <= ?`,
        [batchId, reference, stamp, organizerId, stamp],
      );
      const claimed = rowsToObjects(await turso(
        "SELECT COUNT(*) AS entry_count, COALESCE(SUM(net_amount),0) AS total_amount FROM organizer_payouts WHERE batch_id = ?",
        [batchId],
      ))[0];
      const claimedCount = Number(claimed?.entry_count || 0);
      const claimedAmount = Number(claimed?.total_amount || 0);
      if (!claimedCount) {
        await turso("DELETE FROM organizer_payout_batches WHERE id = ?", [batchId]).catch(() => undefined);
        skip("CLAIMED_BY_ANOTHER_RUN");
        continue;
      }

      const recipient = await ensureOrganizerRecipient(organizerId, { actor: options.actor });
      const transfer = await initiatePaystackTransfer({
        amount: claimedAmount,
        recipientCode: recipient.recipientCode,
        reference,
        reason: "UMaTeXPRESS trip earnings",
      });
      await turso(
        "UPDATE organizer_payout_batches SET total_amount=?,entry_count=?,transfer_code=?,recipient_code=?,status=?,reason=?,updated_at=? WHERE id=?",
        [
          claimedAmount, claimedCount, transfer.transferCode, recipient.recipientCode,
          transfer.status === "SUCCESS" ? "SUCCESS" : "PENDING",
          transfer.awaitingOtp ? AWAITING_OTP_REASON : transfer.reason,
          stamp, batchId,
        ],
      );
      if (transfer.status === "SUCCESS") {
        await settlePayoutBatch({ batchId, stamp });
        summary.transferred += 1;
      } else if (transfer.status === "FAILED" || transfer.status === "REVERSED") {
        await failPayoutBatch({ batchId, reason: transfer.reason || transfer.rawStatus || "TRANSFER_FAILED", stamp });
        summary.failed.push({ organizerId, reason: transfer.reason || "TRANSFER_FAILED" });
        continue;
      } else {
        // In flight. The budget stays spent: the money is already committed.
        summary.inFlight += 1;
      }
      summary.totalTransferred += claimedAmount;
      budget -= claimedAmount + fee;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      await failPayoutBatch({ batchId, reason, stamp }).catch(() => undefined);
      summary.failed.push({ organizerId, reason });
      logEvent("error", "payout_transfer_failed", { organizerId, batchId, reason });
    }
  }
  logEvent("info", "payout_release_ran", {
    considered: summary.considered,
    transferred: summary.transferred,
    inFlight: summary.inFlight,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    manual,
  });
  return summary;
}

/** Paystack said the money arrived: this is the only place an entry is released by automation. */
async function settlePayoutBatch(input: { batchId: string; stamp: string }) {
  const moved = await turso(
    `UPDATE organizer_payouts SET status='RELEASED', released_at=?, transferred_at=?, last_error='', updated_at=?
     WHERE batch_id = ? AND status = 'PROCESSING'`,
    [input.stamp, input.stamp, input.stamp, input.batchId],
  );
  await turso(
    "UPDATE organizer_payout_batches SET status='SUCCESS', settled_at=?, reason='', updated_at=? WHERE id=?",
    [input.stamp, input.stamp, input.batchId],
  );
  return { released: Number(moved?.affected_row_count || 0) };
}

/**
 * A transfer that did not arrive. The entries go back to being owed rather
 * than becoming a debt, because the platform still holds the money — this is
 * the opposite situation to a refund after a payout, which does create one.
 */
async function failPayoutBatch(input: { batchId: string; reason: string; stamp: string }) {
  const reason = String(input.reason || "TRANSFER_FAILED").slice(0, 200);
  await turso(
    `UPDATE organizer_payouts
       SET status = CASE WHEN payout_attempts + 1 >= ? THEN 'FAILED' ELSE 'ACCRUED' END,
           payout_attempts = payout_attempts + 1, last_error = ?, batch_id = '', updated_at = ?
     WHERE batch_id = ? AND status = 'PROCESSING'`,
    [MAX_TRANSFER_ATTEMPTS, reason, input.stamp, input.batchId],
  );
  await turso(
    "UPDATE organizer_payout_batches SET status='FAILED', reason=?, settled_at=?, updated_at=? WHERE id=?",
    [reason, input.stamp, input.stamp, input.batchId],
  );
}

/**
 * Authorises a transfer Paystack held for a one-time password.
 *
 * The code is sent to whoever owns the Paystack account, so it can only ever
 * come from a person. It is passed straight through: it is never stored on the
 * batch, never logged, and never written to the audit trail — only the fact
 * that the transfer was authorised is.
 *
 * A refusal is not a failure. Paystack rejecting the code leaves the transfer
 * exactly where it was, still waiting, so the batch is untouched and the
 * administrator can try again with the right one.
 */
export async function finalizePayoutBatch(input: { batchId: string; otp: string; actor?: string }) {
  await ensurePayoutTables();
  const batchId = String(input.batchId || "").trim();
  const otp = String(input.otp || "").trim();
  if (!batchId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the payout that needs authorising.", 400);
  if (!otp) throw new CampusEngineError("VALIDATION_ERROR", "Enter the one-time password Paystack sent you.", 400);

  const batch = rowsToObjects(await turso(
    `SELECT id,COALESCE(status,'') AS status,COALESCE(reason,'') AS reason,COALESCE(transfer_code,'') AS transfer_code
     FROM organizer_payout_batches WHERE id = ? LIMIT 1`,
    [batchId],
  ))[0];
  if (!batch) throw new CampusEngineError("NOT_FOUND", "That payout was not found.", 404);
  if (String(batch.status) !== "PENDING") {
    throw new CampusEngineError("INVALID_STATE", "That transfer has already finished, so there is nothing to authorise.", 409);
  }
  if (String(batch.reason) !== AWAITING_OTP_REASON) {
    throw new CampusEngineError("INVALID_STATE", "Paystack is not waiting on a one-time password for that transfer.", 409);
  }
  const transferCode = String(batch.transfer_code || "");
  if (!transferCode) throw new CampusEngineError("INVALID_STATE", "That transfer carries no Paystack code to authorise.", 409);

  const stamp = new Date().toISOString();
  let transfer;
  try {
    transfer = await finalizePaystackTransfer({ transferCode, otp });
  } catch (error) {
    throw new CampusEngineError("ENGINE_ERROR", error instanceof Error ? error.message : "Paystack refused that one-time password.", 502);
  }

  if (transfer.status === "SUCCESS") {
    await settlePayoutBatch({ batchId, stamp });
    await consoleAudit({
      actor: String(input.actor || "system:payouts"),
      action: "ORGANIZER_PAYOUT_TRANSFER_AUTHORISED",
      targetType: "organizer_payout_batch",
      targetReference: batchId,
      // The code itself stays out of the trail; the transfer it released does not.
      details: { transferCode, amount: transfer.amount },
    }).catch(() => undefined);
    return { status: "RELEASED" as const };
  }
  if (transfer.status === "FAILED" || transfer.status === "REVERSED") {
    await failPayoutBatch({ batchId, reason: transfer.reason || transfer.rawStatus || "TRANSFER_FAILED", stamp });
    return { status: "FAILED" as const, reason: transfer.reason };
  }
  if (transfer.awaitingOtp) {
    // Accepted but still held: Paystack wants another code.
    return { status: "PENDING" as const, awaitingOtp: true, reason: transfer.reason };
  }
  // The transfer is on its way. Clearing the marker stops the console asking
  // for a code that has already been used; the webhook or the reconcile job
  // settles it from here.
  await turso("UPDATE organizer_payout_batches SET reason='',updated_at=? WHERE id=? AND status='PENDING'", [stamp, batchId]);
  return { status: "PENDING" as const, awaitingOtp: false };
}

export type PayoutReconcileSummary = {
  scanned: number;
  settled: number;
  failed: number;
  stillPending: number;
};

/**
 * The safety net for a webhook that never arrived (or arrived while the Worker
 * was down). Only batches still marked pending are looked at, so a delivery
 * that already settled is skipped rather than re-settled.
 */
export async function runPayoutReconcileJob(options: { limit?: number; now?: Date } = {}): Promise<PayoutReconcileSummary> {
  const summary: PayoutReconcileSummary = { scanned: 0, settled: 0, failed: 0, stillPending: 0 };
  if (!(await isTursoConfiguredRuntime())) return summary;
  await ensurePayoutTables();
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  // A transfer that is seconds old is not stuck; the wait keeps a fast webhook
  // from racing the job that sent it.
  const cutoff = new Date(now.getTime() - 2 * 60_000).toISOString();
  const limit = Math.max(1, Math.min(MAX_RECONCILE_BATCHES, Math.round(Number(options.limit) || MAX_RECONCILE_BATCHES)));
  const batches = rowsToObjects(await turso(
    `SELECT id,COALESCE(transfer_reference,'') AS transfer_reference,COALESCE(transfer_code,'') AS transfer_code
     FROM organizer_payout_batches
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
        await settlePayoutBatch({ batchId, stamp });
        summary.settled += 1;
      } else if (transfer.status === "FAILED" || transfer.status === "REVERSED") {
        await failPayoutBatch({ batchId, reason: transfer.reason || transfer.rawStatus || "TRANSFER_NOT_SENT", stamp });
        summary.failed += 1;
      } else {
        summary.stillPending += 1;
      }
    } catch (error) {
      // Left pending on purpose: a verify that could not run says nothing
      // about the transfer, and marking it failed would invite a second send.
      logEvent("warn", "payout_reconcile_deferred", { batchId, reason: error instanceof Error ? error.message : "unknown" });
      summary.stillPending += 1;
    }
  }
  if (summary.settled || summary.failed) logEvent("info", "payout_reconcile_ran", summary);
  return summary;
}

/**
 * Transfer webhooks. The reference is ours, so it is what the batch is found
 * by; the transfer code is kept as the fallback for a delivery that arrives
 * with only Paystack's own identifier.
 */
export async function applyPaystackTransferEvent(input: { event: string; data: Record<string, unknown> }) {
  await ensurePayoutTables();
  const reference = String(input.data.reference || "").trim();
  const transferCode = String(input.data.transfer_code || "").trim();
  if (!reference && !transferCode) return { handled: false, reason: "REFERENCE_REQUIRED" };
  const batch = rowsToObjects(await turso(
    `SELECT id,COALESCE(status,'') AS status FROM organizer_payout_batches
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
        : normalizeTransferStatus(input.data.status);
  const reason = String(input.data.reason || input.data.gateway_response || input.event || "").slice(0, 200);
  if (status === "SUCCESS") {
    await settlePayoutBatch({ batchId, stamp });
    return { handled: true, status: "RELEASED" };
  }
  if (status === "FAILED" || status === "REVERSED") {
    await failPayoutBatch({ batchId, reason, stamp });
    return { handled: true, status: "RETURNED_TO_LEDGER" };
  }
  return { handled: false, reason: "NOT_ACTIONABLE" };
}

/**
 * The manual retry path. An entry that exhausted its attempts is parked, not
 * lost, and this is what brings it back once a person has fixed whatever was
 * wrong with the destination.
 */
export async function retryFailedPayouts(input: { organizerId: string; actor: string }) {
  await ensurePayoutTables();
  const organizerId = String(input.organizerId || "").trim();
  if (!organizerId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an organizer.", 400);
  const result = await turso(
    "UPDATE organizer_payouts SET status='ACCRUED', payout_attempts=0, last_error='', updated_at=? WHERE organizer_id = ? AND status = 'FAILED'",
    [new Date().toISOString(), organizerId],
  );
  const released = Number(result?.affected_row_count || 0);
  await consoleAudit({
    actor: String(input.actor || "system"),
    action: "ORGANIZER_PAYOUT_RETRY_REQUESTED",
    targetType: "trip_organizer",
    targetReference: organizerId,
    details: { entries: released },
  });
  return { entries: released };
}
