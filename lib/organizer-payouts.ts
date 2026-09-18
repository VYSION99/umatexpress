import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { logEvent } from "@/lib/observability";
import { ensureBookingsTable, ensurePaymentsTable, isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * The money ledger for vacationRide organizers.
 *
 * One row per confirmed booking, written at confirmation time. Amounts are
 * pesewas and append-only: a release or a reversal changes `status` and the
 * timestamps, never the gross, the commission or the net. That is what makes
 * the statement reconcile to the bookings behind it.
 *
 * Phase 4 records payouts; it does not execute transfers. An administrator
 * makes the transfer and records the reference here, which is the one field
 * Phase 5's Paystack Transfers will fill in for itself.
 */

export const PAYOUT_STATUSES = ["ACCRUED", "RELEASED", "REVERSED", "FAILED"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const PAYOUTS_SCHEMA_VERSION = "2026-09-18.1";
const DEFAULT_COMMISSION_BPS = 300;
const MAX_BATCH_ENTRIES = 500;

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
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_organizer_payout_batches ON organizer_payout_batches(organizer_id, created_at)",
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
 * Ghana is UTC+0 all year, with no daylight saving, so the local clock and UTC
 * are the same clock and a payout released "at midnight" needs no zone table.
 */
function nextMidnight(now: Date) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

/**
 * A payout is never released before the coach has departed, and never on the
 * same midnight as the sale: a booking made at 23:59 must not be payable a
 * minute later. So the gate is the later of the next midnight and departure
 * plus a day.
 */
export function releaseAfterFor(travelDate: unknown, departureTime: unknown, now = new Date()) {
  const date = String(travelDate || "").trim();
  const time = /^\d{2}:\d{2}$/.test(String(departureTime || "")) ? String(departureTime) : "00:00";
  const departure = Date.parse(`${date}T${time}:00.000Z`);
  const departureGate = Number.isNaN(departure) ? now.getTime() : departure + 24 * 60 * 60_000;
  return new Date(Math.max(nextMidnight(now), departureGate)).toISOString();
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
  travel_date: string;
  departure_time: string;
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
         b.travel_date, COALESCE(b.departure_time,'') AS departure_time, b.booking_status,
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
    const releaseAfter = releaseAfterFor(row.travel_date, row.departure_time);
    const payoutId = crypto.randomUUID();
    const stamp = new Date().toISOString();

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
  /** Everything earned and not yet released. */
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
  COALESCE(SUM(CASE WHEN status = 'ACCRUED' THEN net_amount ELSE 0 END),0) AS accrued,
  COALESCE(SUM(CASE WHEN status = 'ACCRUED' AND release_after <= ? THEN net_amount ELSE 0 END),0) AS ready,
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
       COALESCE(SUM(CASE WHEN status = 'ACCRUED' THEN net_amount ELSE 0 END),0) AS accrued,
       COALESCE(SUM(CASE WHEN status = 'ACCRUED' AND release_after <= ? THEN net_amount ELSE 0 END),0) AS ready,
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
  note: string;
  createdBy: string;
  createdAt: string;
};

/** One organizer's ledger, newest first. Organizers only ever read their own. */
export async function organizerStatement(organizerId: string) {
  await ensurePayoutTables();
  const rows = rowsToObjects(await turso(
    `SELECT p.id,p.booking_id,p.booking_reference,p.trip_id,
       COALESCE(t.title,'') AS title,COALESCE(t.route_from,'') AS route_from,COALESCE(t.route_to,'') AS route_to,
       p.gross_amount,p.commission_amount,p.net_amount,p.commission_bps,p.release_after,p.status,
       COALESCE(p.transfer_reference,'') AS transfer_reference,COALESCE(p.released_at,'') AS released_at,
       COALESCE(p.reversed_at,'') AS reversed_at,COALESCE(p.reversed_reason,'') AS reversed_reason,p.created_at
     FROM organizer_payouts p LEFT JOIN scheduled_trips t ON t.id = p.trip_id
     WHERE p.organizer_id = ? ORDER BY p.created_at DESC LIMIT 200`,
    [organizerId],
  ));
  const batches = rowsToObjects(await turso(
    `SELECT id,total_amount,entry_count,COALESCE(transfer_reference,'') AS transfer_reference,COALESCE(note,'') AS note,
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
      note: String(row.note || ""),
      createdBy: String(row.created_by || ""),
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
    throw new CampusEngineError("INVALID_STATE", "No payout is ready yet: entries release after midnight following the trip.", 409);
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
