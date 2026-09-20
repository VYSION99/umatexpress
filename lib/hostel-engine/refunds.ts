import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelResidencyTables, type HostelBooking } from "@/lib/hostel-engine/residency";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric, logEvent } from "@/lib/observability";
import { initiatePaystackRefund, verifyPaystackRefund } from "@/lib/paystack";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Cancellation and the refund policy.
 *
 * A cancellation frees the bed and returns part or all of the year's money,
 * decided by how close the academic year is: a month out is a full refund, a
 * week out is half, and inside the last week the year has effectively started.
 * A person may override the policy with a reason, because a bereavement or a
 * platform mistake is not a date calculation.
 *
 * The bed's accrual is reversed with the refund: nobody lives in the room, so
 * the landlord is not paid for it. If the money had already been transferred,
 * the reversal becomes a debt on that landlord's next payout, exactly as the
 * trip side treats a refund after release. Paystack processes the actual
 * transfer back to the student asynchronously; until it says `processed`, the
 * refund sits approved-but-pending, and the webhook or a reconcile finishes it.
 */

export const HOSTEL_REFUND_POLICY = [
  { tier: "FULL", daysBeforeStart: 30, percent: 100, note: "A month or more before the year starts: everything back." },
  { tier: "HALF", daysBeforeStart: 7, percent: 50, note: "Inside a month but more than a week out: half back." },
  { tier: "NONE", daysBeforeStart: 0, percent: 0, note: "Inside the last week: the year has effectively started." },
] as const;
export type HostelRefundTier = (typeof HOSTEL_REFUND_POLICY)[number]["tier"];
export const HOSTEL_REFUND_STATUSES = ["REQUESTED", "APPROVED", "PAID", "DECLINED", "FAILED"] as const;
export type HostelRefundStatus = (typeof HOSTEL_REFUND_STATUSES)[number];

const REFUND_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_refunds (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    reference TEXT NOT NULL,
    landlord_id TEXT NOT NULL DEFAULT '',
    student_email TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 0,
    gross_amount INTEGER NOT NULL DEFAULT 0,
    commission_amount INTEGER NOT NULL DEFAULT 0,
    net_amount INTEGER NOT NULL DEFAULT 0,
    policy TEXT NOT NULL DEFAULT 'NONE',
    percent INTEGER NOT NULL DEFAULT 0,
    override_reason TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    requested_by TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL DEFAULT '',
    paystack_reference TEXT NOT NULL DEFAULT '',
    provider_status TEXT NOT NULL DEFAULT '',
    settled_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_refunds_booking ON hostel_refunds(booking_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_refunds_status ON hostel_refunds(status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_refunds_landlord ON hostel_refunds(landlord_id, status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_refunds_provider ON hostel_refunds(paystack_reference) WHERE paystack_reference <> ''",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_refunds_open ON hostel_refunds(booking_id) WHERE status IN ('REQUESTED','APPROVED')",
];

export type HostelRefund = {
  id: string;
  bookingId: string;
  reference: string;
  landlordId: string;
  studentEmail: string;
  amount: number;
  grossAmount: number;
  commissionAmount: number;
  netAmount: number;
  policy: string;
  percent: number;
  overrideReason: string;
  reason: string;
  status: HostelRefundStatus;
  requestedBy: string;
  decidedBy: string;
  decidedAt: string;
  paystackReference: string;
  providerStatus: string;
  settledAt: string;
  createdAt: string;
  updatedAt: string;
};

export type HostelRefundQuote = {
  reference: string;
  policy: HostelRefundTier;
  percent: number;
  amount: number;
  grossAmount: number;
  commissionAmount: number;
  netAmount: number;
  daysBeforeStart: number;
  note: string;
  canRequest: boolean;
  blockedReason: string;
};

let refundTablesReady: Promise<void> | null = null;

export function ensureHostelRefundTables() {
  refundTablesReady ??= (async () => {
    await ensureHostelTables();
    await ensureHostelResidencyTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelRefunds", version: "024_hostel_refunds", statements: REFUND_SCHEMA_STATEMENTS });
  })().catch((error: unknown) => {
    refundTablesReady = null;
    throw error;
  });
  return refundTablesReady;
}

const REFUND_COLUMNS = `id,booking_id,reference,COALESCE(landlord_id,'') AS landlord_id,COALESCE(student_email,'') AS student_email,
  amount,gross_amount,commission_amount,net_amount,COALESCE(policy,'NONE') AS policy,COALESCE(percent,0) AS percent,
  COALESCE(override_reason,'') AS override_reason,COALESCE(reason,'') AS reason,COALESCE(status,'REQUESTED') AS status,
  COALESCE(requested_by,'') AS requested_by,COALESCE(decided_by,'') AS decided_by,COALESCE(decided_at,'') AS decided_at,
  COALESCE(paystack_reference,'') AS paystack_reference,COALESCE(provider_status,'') AS provider_status,COALESCE(settled_at,'') AS settled_at,
  created_at,updated_at`;

function refundView(row: Record<string, unknown>): HostelRefund {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    reference: String(row.reference || ""),
    landlordId: String(row.landlord_id || ""),
    studentEmail: String(row.student_email || ""),
    amount: Number(row.amount || 0),
    grossAmount: Number(row.gross_amount || 0),
    commissionAmount: Number(row.commission_amount || 0),
    netAmount: Number(row.net_amount || 0),
    policy: String(row.policy || "NONE"),
    percent: Number(row.percent || 0),
    overrideReason: String(row.override_reason || ""),
    reason: String(row.reason || ""),
    status: String(row.status || "REQUESTED") as HostelRefundStatus,
    requestedBy: String(row.requested_by || ""),
    decidedBy: String(row.decided_by || ""),
    decidedAt: String(row.decided_at || ""),
    paystackReference: String(row.paystack_reference || ""),
    providerStatus: String(row.provider_status || ""),
    settledAt: String(row.settled_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value: string) {
  const parsed = new Date(`${String(value || "").slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * What the policy says today, in whole pesewas. Refunds never exceed what was
 * paid, and every share is rounded down so the platform cannot refund a pesewa
 * it never received.
 */
export function hostelRefundQuote(booking: Pick<HostelBooking, "reference" | "totalAmount" | "commissionAmount" | "netAmount" | "periodStartsOn" | "status">, now = new Date()): HostelRefundQuote {
  const start = startOfDay(booking.periodStartsOn);
  const daysBeforeStart = start ? Math.floor((start.getTime() - now.getTime()) / DAY_MS) : 0;
  const tier = HOSTEL_REFUND_POLICY.find((entry) => daysBeforeStart >= entry.daysBeforeStart) || HOSTEL_REFUND_POLICY[HOSTEL_REFUND_POLICY.length - 1];
  const total = Math.max(0, Math.round(Number(booking.totalAmount || 0)));
  const percent = tier.percent;
  const amount = Math.floor((total * percent) / 100);
  const commissionAmount = Math.floor((Math.max(0, Math.round(Number(booking.commissionAmount || 0))) * percent) / 100);
  const grossAmount = amount;
  const netAmount = Math.max(0, grossAmount - commissionAmount);
  const blockedReason = booking.status === "PAID" || booking.status === "PAYMENT_REVIEW"
    ? ""
    : `Only a paid booking can be refunded (this one is ${String(booking.status || "unknown")}).`;
  return {
    reference: booking.reference,
    policy: tier.tier,
    percent,
    amount,
    grossAmount,
    commissionAmount,
    netAmount,
    daysBeforeStart,
    note: tier.note,
    canRequest: !blockedReason && amount > 0,
    blockedReason: blockedReason || (amount === 0 ? tier.note : ""),
  };
}

export async function listHostelRefunds(options: { status?: string; limit?: number } = {}) {
  await ensureHostelRefundTables();
  const status = HOSTEL_REFUND_STATUSES.includes(String(options.status || "").toUpperCase() as HostelRefundStatus)
    ? String(options.status).toUpperCase()
    : "";
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 100), 1), 300);
  const rows = status
    ? rowsToObjects(await turso(`SELECT ${REFUND_COLUMNS} FROM hostel_refunds WHERE status = ? ORDER BY created_at DESC LIMIT ?`, [status, limit]))
    : rowsToObjects(await turso(`SELECT ${REFUND_COLUMNS} FROM hostel_refunds ORDER BY created_at DESC LIMIT ?`, [limit]));
  return rows.map(refundView);
}

export async function getHostelRefund(refundId: string) {
  await ensureHostelRefundTables();
  const row = rowsToObjects(await turso(`SELECT ${REFUND_COLUMNS} FROM hostel_refunds WHERE id = ? LIMIT 1`, [String(refundId || "")]))[0];
  return row ? refundView(row) : null;
}

/** The student's own refunds, newest first: what was asked for and where it got to. */
export async function listHostelRefundsForStudent(studentEmail: string, options: { limit?: number } = {}) {
  await ensureHostelRefundTables();
  const email = String(studentEmail || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 20), 1), 50);
  const rows = rowsToObjects(await turso(
    `SELECT ${REFUND_COLUMNS} FROM hostel_refunds WHERE student_email = ? ORDER BY created_at DESC LIMIT ?`,
    [email, limit],
  ));
  return rows.map(refundView);
}

/** The latest refund on a booking, whatever its status: what the resident page shows. */
export async function latestRefundForBooking(bookingId: string) {
  await ensureHostelRefundTables();
  const row = rowsToObjects(await turso(
    `SELECT ${REFUND_COLUMNS} FROM hostel_refunds WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1`,
    [String(bookingId || "")],
  ))[0];
  return row ? refundView(row) : null;
}

/** A booking's open refund, if one is in flight. */
export async function openRefundForBooking(bookingId: string) {
  await ensureHostelRefundTables();
  const row = rowsToObjects(await turso(
    `SELECT ${REFUND_COLUMNS} FROM hostel_refunds WHERE booking_id = ? AND status IN ('REQUESTED','APPROVED') ORDER BY created_at DESC LIMIT 1`,
    [String(bookingId || "")],
  ))[0];
  return row ? refundView(row) : null;
}

/**
 * The student's request: recorded at the policy price, waiting for a person.
 * Asking twice while one is open is a conflict rather than a second row.
 */
export async function requestHostelRefund(input: { booking: HostelBooking; reason?: unknown; actor: string }) {
  await ensureHostelRefundTables();
  const quote = hostelRefundQuote(input.booking);
  if (!quote.canRequest) throw new CampusEngineError("INVALID_STATE", quote.blockedReason || "That booking cannot be refunded.", 409);
  const open = await openRefundForBooking(input.booking.id);
  if (open) throw new CampusEngineError("CONFLICT", "A refund request for this booking is already open.", 409);
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await turso(
      `INSERT INTO hostel_refunds (id,booking_id,reference,landlord_id,student_email,amount,gross_amount,commission_amount,net_amount,policy,percent,reason,status,requested_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'REQUESTED',?,?,?)`,
      [id, input.booking.id, input.booking.reference, input.booking.landlordId, input.booking.studentEmail,
        quote.amount, quote.grossAmount, quote.commissionAmount, quote.netAmount, quote.policy, quote.percent,
        reason, String(input.actor || input.booking.studentEmail), stamp, stamp],
    );
  } catch (error) {
    // The open-refund index is the real guard: two taps that both passed the
    // check above cannot both insert, so the second one reads as a conflict.
    if (/unique|constraint/i.test(error instanceof Error ? error.message : String(error))) {
      throw new CampusEngineError("CONFLICT", "A refund request for this booking is already open.", 409);
    }
    throw error;
  }
  if (input.booking.landlordEmail) {
    // The landlord learns that a bed may come back before they find out the
    // student moved out: it is their occupancy the decision changes.
    await queueNotification(turso, {
      recipient: input.booking.landlordEmail,
      template: "hostel_refund_requested",
      subject: `A student asked to cancel ${input.booking.propertyName || "a bed"}`,
      message: `${input.booking.studentName || input.booking.studentEmail} asked to cancel ${input.booking.reference}. The platform decides and will tell you the outcome.`,
      reference: `hostel-refund:${id}:REQUESTED`,
      nowIso: stamp,
    }).catch(() => undefined);
  }
  await incrementMetric("hostel_refund_requested");
  return (await getHostelRefund(id)) as HostelRefund;
}

/**
 * Reverses the bed's accrual. `released_at` is left exactly as it was: that is
 * what tells the ledger whether this reversal merely un-earns money or creates
 * a debt the next payout must absorb.
 */
async function reverseBookingAccrual(bookingId: string, actor: string) {
  const row = rowsToObjects(await turso("SELECT status FROM hostel_payouts WHERE booking_id = ? LIMIT 1", [bookingId]))[0];
  const current = String(row?.status || "");
  // Money mid-flight is the one state a refund must not race: the transfer
  // either lands or returns through the reconcile job, and the refund waits.
  if (current === "PROCESSING") return "PROCESSING";
  if (current && current !== "REVERSED") {
    await turso(
      "UPDATE hostel_payouts SET status = 'REVERSED', last_error = ?, updated_at = ? WHERE booking_id = ? AND status = ?",
      [`Refunded by ${actor}`, new Date().toISOString(), bookingId, current],
    );
  }
  return "REVERSED";
}

/** Frees the bed so another student can take it. */
async function releaseBookingSpace(booking: Pick<HostelBooking, "spaceId" | "id">) {
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ? WHERE id = ? AND status IN ('OCCUPIED','RESERVED')", [stamp, booking.spaceId]);
  await turso("UPDATE hostel_bookings SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status IN ('PAID','PAYMENT_REVIEW')", [stamp, booking.id]);
}

/**
 * The person's yes. It frees the bed, reverses the accrual, and asks Paystack
 * to send the money back; a deployment without Paystack (or a booking paid
 * outside it) records the transfer by hand through `recordHostelRefundPayment`.
 */
export async function approveHostelRefund(input: {
  refundId: string;
  actor: string;
  overridePercent?: unknown;
  reason?: unknown;
}) {
  await ensureHostelRefundTables();
  const refund = await getHostelRefund(input.refundId);
  if (!refund) throw new CampusEngineError("NOT_FOUND", "That refund no longer exists.", 404);
  if (refund.status !== "REQUESTED") throw new CampusEngineError("INVALID_STATE", `That refund is already ${refund.status.toLowerCase()}.`, 409);
  const booking = rowsToObjects(await turso(
    "SELECT id,space_id,status FROM hostel_bookings WHERE id = ? LIMIT 1",
    [refund.bookingId],
  ))[0];
  if (!booking) throw new CampusEngineError("NOT_FOUND", "The booking behind that refund no longer exists.", 404);

  let amount = refund.amount;
  let percent = refund.percent;
  let policy = refund.policy;
  let overrideReason = "";
  if (input.overridePercent !== undefined && input.overridePercent !== null && String(input.overridePercent) !== "") {
    const requested = Math.round(Number(input.overridePercent));
    if (!Number.isFinite(requested) || requested < 0 || requested > 100) {
      throw new CampusEngineError("VALIDATION_ERROR", "An override is a percentage from 0 to 100.", 400);
    }
    overrideReason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (requested !== 100 && !overrideReason) throw new CampusEngineError("VALIDATION_ERROR", "Say why the policy is being overridden.", 400);
    const totalAmount = rowsToObjects(await turso("SELECT total_amount FROM hostel_bookings WHERE id = ? LIMIT 1", [refund.bookingId]))[0];
    amount = Math.floor((Math.max(0, Math.round(Number(totalAmount?.total_amount || 0))) * requested) / 100);
    percent = requested;
    policy = "OVERRIDE";
  }

  const accrualStatus = await reverseBookingAccrual(refund.bookingId, input.actor);
  if (accrualStatus === "PROCESSING") {
    // The reversal did not land: money is mid-flight, so the refund waits.
    throw new CampusEngineError("INVALID_STATE", "A payout for this bed is in flight. Reconcile it before refunding.", 409);
  }
  await releaseBookingSpace({ spaceId: String(booking.space_id || ""), id: refund.bookingId });

  let paystackReference = "";
  let providerStatus = "";
  let status: HostelRefundStatus = "APPROVED";
  if (amount > 0) {
    try {
      const initiation = await initiatePaystackRefund({
        transactionReference: refund.reference,
        amount,
        reason: overrideReason || refund.reason || `Hostel refund for ${refund.reference}`,
      });
      paystackReference = initiation.refundReference;
      providerStatus = initiation.rawStatus;
      if (initiation.status === "PROCESSED") status = "PAID";
      if (initiation.status === "FAILED") status = "FAILED";
    } catch (error) {
      // The bed stays free and the accrual reversed; the money leg is recorded
      // as failed so an administrator can retry or pay it by hand.
      const stamp = new Date().toISOString();
      await turso(
        `UPDATE hostel_refunds SET status = 'FAILED', policy = ?, percent = ?, amount = ?, override_reason = ?,
           decided_by = ?, decided_at = ?, provider_status = ?, updated_at = ? WHERE id = ?`,
        [policy, percent, amount, overrideReason, input.actor, stamp, (error instanceof Error ? error.message : "Paystack refused the refund").slice(0, 200), stamp, refund.id],
      );
      throw new CampusEngineError("ENGINE_ERROR", `The bed was freed and the accrual reversed, but Paystack refused the refund: ${error instanceof Error ? error.message : "unknown"}. Record the refund by hand or retry.`, 502);
    }
  }

  const stamp = new Date().toISOString();
  await turso(
    `UPDATE hostel_refunds SET policy = ?, percent = ?, amount = ?, gross_amount = ?, net_amount = ?, override_reason = ?,
       status = ?, decided_by = ?, decided_at = ?, paystack_reference = ?, provider_status = ?, settled_at = ?, updated_at = ? WHERE id = ?`,
    [policy, percent, amount, amount, Math.max(0, amount - refund.commissionAmount), overrideReason,
      status, input.actor, stamp, paystackReference, providerStatus, status === "PAID" ? stamp : "", stamp, refund.id],
  );
  if (status === "PAID") await finishRefund(refund.bookingId, stamp);
  if (amount > 0 && (status === "PAID" || status === "FAILED")) await incrementMetric("hostel_refund_settled");

  const updated = (await getHostelRefund(refund.id)) as HostelRefund;
  if (refund.studentEmail) {
    await queueNotification(turso, {
      recipient: refund.studentEmail,
      template: "hostel_refund_decided",
      subject: status === "PAID" ? "Your hostel refund has been sent" : "Your hostel refund was approved",
      message: status === "PAID"
        ? `${(amount / 100).toFixed(2)} cedis is on its way back to you for ${refund.reference}.`
        : `${(amount / 100).toFixed(2)} cedis was approved for ${refund.reference} and is being processed by Paystack.`,
      reference: `hostel-refund:${refund.id}:${status}`,
      nowIso: stamp,
    }).catch(() => undefined);
  }
  await consoleAudit({
    actor: input.actor,
    action: "hostel_refund_approved",
    targetType: "hostel_refund",
    targetReference: refund.id,
    details: { amount, percent, policy, reference: refund.reference, paystackReference },
  }).catch(() => undefined);
  logEvent("info", "hostel_refund_approved", { refundId: refund.id, amount, status });
  return updated;
}

export async function declineHostelRefund(input: { refundId: string; reason?: unknown; actor: string }) {
  await ensureHostelRefundTables();
  const refund = await getHostelRefund(input.refundId);
  if (!refund) throw new CampusEngineError("NOT_FOUND", "That refund no longer exists.", 404);
  if (refund.status !== "REQUESTED") throw new CampusEngineError("INVALID_STATE", `That refund is already ${refund.status.toLowerCase()}.`, 409);
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!reason) throw new CampusEngineError("VALIDATION_ERROR", "Say why the refund is being declined.", 400);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_refunds SET status = 'DECLINED', decided_by = ?, decided_at = ?, provider_status = ?, updated_at = ? WHERE id = ?",
    [input.actor, stamp, reason, stamp, refund.id],
  );
  if (refund.studentEmail) {
    await queueNotification(turso, {
      recipient: refund.studentEmail,
      template: "hostel_refund_decided",
      subject: "Your hostel refund request was declined",
      message: `${refund.reference}: ${reason}`,
      reference: `hostel-refund:${refund.id}:DECLINED`,
      nowIso: stamp,
    }).catch(() => undefined);
  }
  await consoleAudit({ actor: input.actor, action: "hostel_refund_declined", targetType: "hostel_refund", targetReference: refund.id, details: { reason } }).catch(() => undefined);
  return (await getHostelRefund(refund.id)) as HostelRefund;
}

/** A transfer made outside Paystack, recorded with the reference it landed under. */
export async function recordHostelRefundPayment(input: { refundId: string; reference?: unknown; actor: string; note?: unknown }) {
  await ensureHostelRefundTables();
  const refund = await getHostelRefund(input.refundId);
  if (!refund) throw new CampusEngineError("NOT_FOUND", "That refund no longer exists.", 404);
  if (!["APPROVED", "FAILED"].includes(refund.status)) {
    throw new CampusEngineError("INVALID_STATE", "Only an approved refund can be recorded as paid.", 409);
  }
  const reference = String(input.reference || "").trim().slice(0, 80);
  if (reference.length < 3) throw new CampusEngineError("VALIDATION_ERROR", "Record the reference the refund was sent under.", 400);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_refunds SET status = 'PAID', paystack_reference = ?, provider_status = ?, settled_at = ?, updated_at = ? WHERE id = ?",
    [reference, String(input.note || "RECORDED_BY_HAND").slice(0, 200), stamp, stamp, refund.id],
  );
  await finishRefund(refund.bookingId, stamp);
  await consoleAudit({ actor: input.actor, action: "hostel_refund_recorded", targetType: "hostel_refund", targetReference: refund.id, details: { reference } }).catch(() => undefined);
  return (await getHostelRefund(refund.id)) as HostelRefund;
}

/** The webhook's door: `refund.processed` settles, `refund.failed` releases the debt. */
export async function applyHostelRefundEvent(input: { event: string; reference?: string; status?: string; amount?: number }) {
  await ensureHostelRefundTables();
  const reference = String(input.reference || "").trim();
  if (!reference) return { handled: false, reason: "REFUND_REFERENCE_MISSING" as const };
  const row = rowsToObjects(await turso(
    `SELECT ${REFUND_COLUMNS} FROM hostel_refunds WHERE paystack_reference = ? LIMIT 1`,
    [reference],
  ))[0];
  const refund = row ? refundView(row) : null;
  if (!refund) return { handled: false, reason: "REFUND_NOT_FOUND" as const };
  const stamp = new Date().toISOString();
  const event = String(input.event || "").toLowerCase();
  if (event === "refund.processed" || String(input.status || "").toLowerCase() === "processed") {
    if (refund.status === "PAID") return { handled: true, status: "ALREADY_PAID" as const, refundId: refund.id };
    await turso(
      "UPDATE hostel_refunds SET status = 'PAID', provider_status = 'processed', settled_at = ?, updated_at = ? WHERE id = ?",
      [stamp, stamp, refund.id],
    );
    await finishRefund(refund.bookingId, stamp);
    logEvent("info", "hostel_refund_settled", { refundId: refund.id, amount: refund.amount });
    return { handled: true, status: "PAID" as const, refundId: refund.id };
  }
  if (event === "refund.failed" || String(input.status || "").toLowerCase() === "failed") {
    await turso(
      "UPDATE hostel_refunds SET status = 'FAILED', provider_status = ?, updated_at = ? WHERE id = ?",
      [String(input.status || "failed").slice(0, 100), stamp, refund.id],
    );
    logEvent("warn", "hostel_refund_failed_by_provider", { refundId: refund.id });
    return { handled: true, status: "FAILED" as const, refundId: refund.id };
  }
  return { handled: true, status: "IGNORED" as const, refundId: refund.id };
}

/** Asks Paystack where a pending refund got to; the button an administrator presses. */
export async function runHostelRefundReconcile(options: { limit?: number } = {}) {
  await ensureHostelRefundTables();
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 10), 1), 25);
  const pending = await listHostelRefunds({ status: "APPROVED", limit });
  const summary = { scanned: 0, settled: 0, failed: 0, stillPending: 0 };
  for (const refund of pending.filter((entry) => entry.paystackReference)) {
    summary.scanned += 1;
    try {
      const verified = await verifyPaystackRefund(refund.paystackReference);
      const applied = await applyHostelRefundEvent({
        event: verified.status === "PROCESSED" ? "refund.processed" : verified.status === "FAILED" ? "refund.failed" : "refund.pending",
        reference: refund.paystackReference,
        status: verified.rawStatus,
        amount: verified.amount,
      });
      if (applied.status === "PAID") summary.settled += 1;
      else if (applied.status === "FAILED") summary.failed += 1;
      else summary.stillPending += 1;
    } catch {
      summary.stillPending += 1;
    }
  }
  return summary;
}

/** The booking reaches its final state only when the money is actually back. */
async function finishRefund(bookingId: string, stamp: string) {
  await turso("UPDATE hostel_bookings SET status = 'REFUNDED', updated_at = ? WHERE id = ?", [stamp, bookingId]);
}
