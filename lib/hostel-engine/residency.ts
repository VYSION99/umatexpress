import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables, HOSTEL_DEFAULT_COMMISSION_BPS } from "@/lib/hostel-engine/landlord";
import { ensureHostelMessageTables } from "@/lib/hostel-engine/message-schema";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric, logEvent } from "@/lib/observability";
import { hashPaymentToken } from "@/lib/payment-access";
import { initializePaystackTransaction } from "@/lib/paystack";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Hostel residency: the bed a student paid for.
 *
 * Money is pesewas everywhere. The student pays the published bed price plus
 * the utilities fee when the property charges one; the platform keeps
 * `commission_bps` (3% by default) of that payment and the landlord's share is
 * written to `hostel_payouts` as an accrual, so the payout phase releases a
 * ledger that already exists rather than rebuilding one from bookings.
 *
 * A booking holds its bed for ten minutes while Paystack checkout runs. The
 * claim is one conditional UPDATE on the bed, which is the only place a race
 * for the same bed can be lost.
 */

export const HOSTEL_BOOKING_STATUSES = ["PENDING_PAYMENT", "PAID", "PAYMENT_REVIEW", "EXPIRED", "CANCELLED", "REFUNDED"] as const;
export type HostelBookingStatus = (typeof HOSTEL_BOOKING_STATUSES)[number];

export const HOSTEL_SPACE_CLAIM_STATUSES = ["RESERVED", "OCCUPIED"] as const;

/** Ten minutes is enough to finish a Paystack checkout, and no longer. */
export const HOSTEL_HOLD_MINUTES = 10;

/**
 * How long an expired hold is kept before it is released without a provider
 * check. The sweep runs every five minutes and asks Paystack first, so this is
 * only the backstop for a paid checkout whose webhook never arrived and whose
 * verification kept failing: three sweeps of grace before a bed is given back.
 */
export const HOSTEL_HOLD_GRACE_MINUTES = 15;

export { HOSTEL_DEFAULT_COMMISSION_BPS };

/** Days before the academic year starts that a landlord's share becomes payable. */
export const HOSTEL_RELEASE_LEAD_DAYS = 3;

const RESIDENCY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_bookings (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    room_id TEXT NOT NULL DEFAULT '',
    property_id TEXT NOT NULL,
    landlord_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    student_email TEXT NOT NULL DEFAULT '',
    student_name TEXT NOT NULL DEFAULT '',
    student_phone TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    utilities_fee INTEGER NOT NULL DEFAULT 0,
    total_amount INTEGER NOT NULL,
    commission_bps INTEGER NOT NULL DEFAULT ${HOSTEL_DEFAULT_COMMISSION_BPS},
    commission_amount INTEGER NOT NULL DEFAULT 0,
    net_amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    hold_expires_at TEXT NOT NULL DEFAULT '',
    paid_at TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    provider_reference TEXT NOT NULL DEFAULT '',
    access_token_hash TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_payouts (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    landlord_id TEXT NOT NULL,
    gross_amount INTEGER NOT NULL,
    commission_bps INTEGER NOT NULL,
    commission_amount INTEGER NOT NULL,
    net_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACCRUED',
    release_after TEXT NOT NULL,
    released_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_bookings_reference ON hostel_bookings(reference)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_bookings_student ON hostel_bookings(student_email, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_bookings_landlord ON hostel_bookings(landlord_id, status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_bookings_space ON hostel_bookings(space_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_bookings_hold ON hostel_bookings(status, hold_expires_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_payouts_booking ON hostel_payouts(booking_id)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_payouts_landlord ON hostel_payouts(landlord_id, status, release_after)",
  // The platform rate is 3%. Every landlord row still carrying the placeholder
  // 5% default moves with it; an explicitly negotiated rate was never stored as
  // 500, so the update cannot overwrite a decision someone made on purpose.
  `UPDATE hostel_landlords SET commission_bps = ${HOSTEL_DEFAULT_COMMISSION_BPS} WHERE commission_bps = 500`,
];

let residencyTablesReady: Promise<void> | null = null;

/** Memoised per isolate; a booking must not run DDL on its own request. */
export function ensureHostelResidencyTables() {
  residencyTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ id: "hostel_residency", version: "015_hostel_residency", statements: RESIDENCY_SCHEMA_STATEMENTS });
  })();
  return residencyTablesReady;
}

export type HostelBooking = {
  id: string;
  reference: string;
  listingId: string;
  spaceId: string;
  roomId: string;
  roomLabel: string;
  spaceLabel: string;
  propertyId: string;
  propertyName: string;
  propertyAddress: string;
  landlordId: string;
  landlordName: string;
  landlordPhone: string;
  landlordEmail: string;
  periodId: string;
  periodName: string;
  periodStartsOn: string;
  periodEndsOn: string;
  studentEmail: string;
  studentName: string;
  studentPhone: string;
  price: number;
  utilitiesFee: number;
  totalAmount: number;
  commissionBps: number;
  commissionAmount: number;
  netAmount: number;
  status: HostelBookingStatus;
  holdExpiresAt: string;
  paidAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

const BOOKING_COLUMNS = `b.id,b.reference,b.listing_id,b.space_id,b.room_id,b.property_id,b.landlord_id,b.period_id,
  b.student_email,b.student_name,b.student_phone,b.price,b.utilities_fee,b.total_amount,b.commission_bps,
  b.commission_amount,b.net_amount,b.status,b.hold_expires_at,b.paid_at,b.note,b.created_at,b.updated_at,
  COALESCE(p.name,'') AS property_name,COALESCE(p.address,'') AS property_address,
  COALESCE(r.label,'') AS room_label,COALESCE(s.label,'') AS space_label,
  COALESCE(pe.name,'') AS period_name,COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.ends_on,'') AS period_ends_on,
  COALESCE(h.name,'') AS landlord_name,COALESCE(h.phone,'') AS landlord_phone,COALESCE(h.email,'') AS landlord_email`;

const BOOKING_JOINS = `FROM hostel_bookings b
  LEFT JOIN hostel_properties p ON p.id = b.property_id
  LEFT JOIN hostel_rooms r ON r.id = b.room_id
  LEFT JOIN hostel_spaces s ON s.id = b.space_id
  LEFT JOIN hostel_periods pe ON pe.id = b.period_id
  LEFT JOIN hostel_landlords h ON h.id = b.landlord_id`;

function bookingView(row: Record<string, unknown>): HostelBooking {
  return {
    id: String(row.id || ""),
    reference: String(row.reference || ""),
    listingId: String(row.listing_id || ""),
    spaceId: String(row.space_id || ""),
    roomId: String(row.room_id || ""),
    roomLabel: String(row.room_label || ""),
    spaceLabel: String(row.space_label || ""),
    propertyId: String(row.property_id || ""),
    propertyName: String(row.property_name || ""),
    propertyAddress: String(row.property_address || ""),
    landlordId: String(row.landlord_id || ""),
    landlordName: String(row.landlord_name || ""),
    landlordPhone: String(row.landlord_phone || ""),
    landlordEmail: String(row.landlord_email || ""),
    periodId: String(row.period_id || ""),
    periodName: String(row.period_name || ""),
    periodStartsOn: String(row.period_starts_on || ""),
    periodEndsOn: String(row.period_ends_on || ""),
    studentEmail: String(row.student_email || ""),
    studentName: String(row.student_name || ""),
    studentPhone: String(row.student_phone || ""),
    price: Number(row.price || 0),
    utilitiesFee: Number(row.utilities_fee || 0),
    totalAmount: Number(row.total_amount || 0),
    commissionBps: Number(row.commission_bps || HOSTEL_DEFAULT_COMMISSION_BPS),
    commissionAmount: Number(row.commission_amount || 0),
    netAmount: Number(row.net_amount || 0),
    status: String(row.status || "PENDING_PAYMENT") as HostelBookingStatus,
    holdExpiresAt: String(row.hold_expires_at || ""),
    paidAt: String(row.paid_at || ""),
    note: String(row.note || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export function splitHostelPayment(totalAmount: number, commissionBps: number) {
  const gross = Math.max(0, Math.round(Number(totalAmount) || 0));
  const bps = Number.isFinite(commissionBps) && commissionBps >= 0 && commissionBps < 10_000
    ? Math.round(commissionBps)
    : HOSTEL_DEFAULT_COMMISSION_BPS;
  const commission = Math.round((gross * bps) / 10_000);
  return { gross, commissionBps: bps, commission, net: gross - commission };
}

/**
 * A landlord is paid shortly before the year they let begins, not the day the
 * student pays, so a refund or a cancellation is settled out of money the
 * platform still holds. A year that already started is due immediately.
 */
export function releaseAfterFor(periodStartsOn: unknown, now = new Date()) {
  const parsed = new Date(`${String(periodStartsOn || "").trim()}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  }
  parsed.setUTCDate(parsed.getUTCDate() - HOSTEL_RELEASE_LEAD_DAYS);
  return new Date(Math.max(parsed.getTime(), now.getTime())).toISOString();
}

function bookingReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `HF-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function paymentToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Frees every bed whose hold ran out and whose grace has passed. */
export async function releaseExpiredHostelHolds(options: { graceMinutes?: number } = {}) {
  await ensureHostelResidencyTables();
  const graceMinutes = Math.max(0, Math.round(options.graceMinutes ?? HOSTEL_HOLD_GRACE_MINUTES));
  const now = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const released = await turso(
    `UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ?
     WHERE status = 'RESERVED' AND id IN (
       SELECT space_id FROM hostel_bookings WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <> '' AND hold_expires_at < ?
     )`,
    [now, now],
  );
  const expired = await turso(
    "UPDATE hostel_bookings SET status = 'EXPIRED', updated_at = ? WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <> '' AND hold_expires_at < ?",
    [now, now],
  );
  const count = Number(expired?.affected_row_count || 0);
  if (count) {
    await incrementMetric("hostel_holds_expired");
    logEvent("info", "hostel_holds_expired", { count, released: Number(released?.affected_row_count || 0) });
  }
  return count;
}

async function bookableListing(listingId: string) {
  const row = rowsToObjects(await turso(
    `SELECT l.id AS listing_id,l.space_id,l.period_id,l.price,
       COALESCE(s.status,'AVAILABLE') AS space_status,COALESCE(s.label,'') AS space_label,
       r.id AS room_id,COALESCE(r.label,'') AS room_label,COALESCE(r.status,'ACTIVE') AS room_status,COALESCE(r.utilities_fee,0) AS utilities_fee,
       p.id AS property_id,COALESCE(p.name,'') AS property_name,COALESCE(p.status,'DRAFT') AS property_status,COALESCE(p.utilities_enabled,0) AS utilities_enabled,
       COALESCE(h.id,'') AS landlord_id,COALESCE(h.commission_bps,${HOSTEL_DEFAULT_COMMISSION_BPS}) AS commission_bps,COALESCE(h.status,'ACTIVE') AS landlord_status,
       COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.active,0) AS period_active
     FROM hostel_listings l
     JOIN hostel_spaces s ON s.id = l.space_id
     JOIN hostel_rooms r ON r.id = s.room_id
     JOIN hostel_properties p ON p.id = r.property_id
     JOIN hostel_landlords h ON h.id = p.landlord_id
     LEFT JOIN hostel_periods pe ON pe.id = l.period_id
     WHERE l.id = ? LIMIT 1`,
    [listingId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That bed is no longer listed.", 404);
  if (String(row.listing_id) === "") throw new CampusEngineError("NOT_FOUND", "That bed is no longer listed.", 404);
  return row;
}

export type StartHostelBookingInput = {
  listingId: string;
  student: { email: string; name: string; phone: string };
  origin: string;
  secure: boolean;
  note?: string;
};

/**
 * Claims a bed and opens Paystack checkout. The claim is one conditional
 * UPDATE, so two students racing for the same bed cannot both win; everything
 * after the claim compensates on failure rather than leaving a held bed with no
 * way to pay for it.
 */
export async function startHostelBooking(input: StartHostelBookingInput) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before taking hostel bookings.", 503);
  }
  await ensureHostelResidencyTables();
  await releaseExpiredHostelHolds();

  const listingId = String(input.listingId || "").trim();
  if (!listingId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a bed to book.", 400);
  const listing = await bookableListing(listingId);
  if (String(listing.listing_id) !== listingId) throw new CampusEngineError("NOT_FOUND", "That bed is no longer listed.", 404);
  if (String(listing.period_active) !== "1") throw new CampusEngineError("INVALID_STATE", "That academic year is closed.", 409);
  if (String(listing.space_status) !== "AVAILABLE") throw new CampusEngineError("INVALID_STATE", "That bed has just been taken. Pick another one.", 409);
  if (String(listing.room_status) !== "ACTIVE" || String(listing.property_status) === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "That bed is not open for booking.", 409);
  }
  if (String(listing.landlord_status) !== "ACTIVE") throw new CampusEngineError("INVALID_STATE", "That landlord is not accepting bookings.", 409);

  const studentEmail = String(input.student.email || "").trim().toLowerCase();
  const alreadyResident = rowsToObjects(await turso(
    "SELECT reference FROM hostel_bookings WHERE student_email = ? AND period_id = ? AND status IN ('PAID','PAYMENT_REVIEW') LIMIT 1",
    [studentEmail, String(listing.period_id)],
  ))[0];
  if (alreadyResident) {
    throw new CampusEngineError("CONFLICT", `You already have a bed for this year (${String(alreadyResident.reference)}).`, 409);
  }

  const stamp = new Date().toISOString();
  const claimed = await turso("UPDATE hostel_spaces SET status = 'RESERVED', updated_at = ? WHERE id = ? AND status = 'AVAILABLE'", [stamp, String(listing.space_id)]);
  if (Number(claimed?.affected_row_count || 0) !== 1) {
    throw new CampusEngineError("INVALID_STATE", "That bed has just been taken. Pick another one.", 409);
  }

  const price = Math.max(0, Math.round(Number(listing.price || 0)));
  const utilitiesFee = Number(listing.utilities_enabled ?? 0) === 1 ? Math.max(0, Math.round(Number(listing.utilities_fee || 0))) : 0;
  const split = splitHostelPayment(price + utilitiesFee, Number(listing.commission_bps || HOSTEL_DEFAULT_COMMISSION_BPS));
  const reference = bookingReference();
  const token = paymentToken();
  const holdExpiresAt = new Date(Date.now() + HOSTEL_HOLD_MINUTES * 60_000).toISOString();

  await turso(
    `INSERT INTO hostel_bookings (id,reference,listing_id,space_id,room_id,property_id,landlord_id,period_id,student_email,student_name,student_phone,
       price,utilities_fee,total_amount,commission_bps,commission_amount,net_amount,status,hold_expires_at,access_token_hash,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING_PAYMENT',?,?,?,?,?)`,
    [
      crypto.randomUUID(), reference, listingId, String(listing.space_id), String(listing.room_id), String(listing.property_id), String(listing.landlord_id),
      String(listing.period_id), studentEmail, String(input.student.name || "").slice(0, 100), String(input.student.phone || "").slice(0, 30),
      price, utilitiesFee, split.gross, split.commissionBps, split.commission, split.net, holdExpiresAt, await hashPaymentToken(token),
      String(input.note || "").slice(0, 300), stamp, stamp,
    ],
  );

  try {
    const paystack = await initializePaystackTransaction({
      email: studentEmail,
      amount: split.gross,
      reference,
      callbackUrl: `${input.origin}/hostel/resident?reference=${encodeURIComponent(reference)}`,
      metadata: { purpose: "HOSTEL_BOOKING", reference, propertyId: String(listing.property_id), spaceId: String(listing.space_id) },
    });
    await incrementMetric("hostel_booking_started");
    const booking = await getHostelBookingByReference(reference);
    return { booking, authorizationUrl: paystack.authorizationUrl, token, secure: input.secure, holdMinutes: HOSTEL_HOLD_MINUTES };
  } catch (error) {
    // No checkout means no hold: give the bed straight back.
    await turso("UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ? WHERE id = ? AND status = 'RESERVED'", [new Date().toISOString(), String(listing.space_id)]).catch(() => undefined);
    await turso("UPDATE hostel_bookings SET status = 'CANCELLED', updated_at = ? WHERE reference = ?", [new Date().toISOString(), reference]).catch(() => undefined);
    throw error;
  }
}

export async function getHostelBookingByReference(reference: string) {
  await ensureHostelResidencyTables();
  const row = rowsToObjects(await turso(`SELECT ${BOOKING_COLUMNS} ${BOOKING_JOINS} WHERE b.reference = ? LIMIT 1`, [reference]))[0];
  return row ? bookingView(row) : null;
}

export async function getHostelBookingById(id: string) {
  await ensureHostelResidencyTables();
  const row = rowsToObjects(await turso(`SELECT ${BOOKING_COLUMNS} ${BOOKING_JOINS} WHERE b.id = ? LIMIT 1`, [id]))[0];
  return row ? bookingView(row) : null;
}

export async function listHostelBookingsForLandlord(landlordId: string, options: { limit?: number } = {}) {
  await ensureHostelResidencyTables();
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const rows = rowsToObjects(await turso(
    `SELECT ${BOOKING_COLUMNS} ${BOOKING_JOINS} WHERE b.landlord_id = ? ORDER BY b.created_at DESC LIMIT ${limit}`,
    [landlordId],
  ));
  return rows.map(bookingView);
}

/**
 * Confirms the money and turns a held bed into a residency.
 *
 * Idempotent: verification and the Paystack webhook both call it for the same
 * reference, and whichever arrives second finds `PAID` and does nothing.
 * A payment that does not match the quoted total is held for review — the bed
 * stays reserved and an administrator decides, because releasing it would take
 * a bed from a student whose money did arrive.
 */
export async function settleHostelBooking(input: { reference: string; amount: number; transactionId?: string; provider?: string; source: string }) {
  await ensureHostelResidencyTables();
  const reference = String(input.reference || "").trim();
  const booking = await getHostelBookingByReference(reference);
  if (!booking) return { handled: false, reason: "BOOKING_NOT_FOUND" as const };
  if (booking.status === "PAID") return { handled: true, status: "ALREADY_PAID" as const, booking };

  const stamp = new Date().toISOString();
  // Money that arrives after the bed was given back is not silently dropped:
  // the student paid, so the booking is flagged for a person to resolve.
  if (booking.status === "EXPIRED" || booking.status === "CANCELLED") {
    if (Math.round(Number(input.amount || 0)) >= booking.totalAmount) {
      await turso(
        "UPDATE hostel_bookings SET status = 'PAYMENT_REVIEW', paid_at = ?, provider = ?, provider_reference = ?, updated_at = ? WHERE reference = ? AND status IN ('EXPIRED','CANCELLED')",
        [stamp, String(input.provider || ""), String(input.transactionId || ""), stamp, reference],
      );
      await incrementMetric("hostel_payment_review");
      logEvent("warn", "hostel_payment_after_hold_expired", { reference, amount: Number(input.amount || 0), source: input.source });
      return { handled: true, status: "PAYMENT_REVIEW" as const, booking: await getHostelBookingByReference(reference) };
    }
    return { handled: true, status: "NOT_PENDING" as const, booking };
  }
  if (booking.status !== "PENDING_PAYMENT") return { handled: true, status: "NOT_PENDING" as const, booking };

  if (Math.round(Number(input.amount || 0)) < booking.totalAmount) {
    await turso(
      "UPDATE hostel_bookings SET status = 'PAYMENT_REVIEW', paid_at = ?, provider = ?, provider_reference = ?, updated_at = ? WHERE reference = ?",
      [stamp, String(input.provider || ""), String(input.transactionId || ""), stamp, reference],
    );
    await incrementMetric("hostel_payment_review");
    logEvent("warn", "hostel_payment_amount_mismatch", { reference, expected: booking.totalAmount, received: Number(input.amount || 0), source: input.source });
    return { handled: true, status: "PAYMENT_REVIEW" as const, booking: await getHostelBookingByReference(reference) };
  }

  // Only one writer may turn a held bed into a residency: the loser of the race
  // returns the booking it read, without touching the bed, the ledger or the
  // thread a second time.
  const confirmed = await turso(
    "UPDATE hostel_bookings SET status = 'PAID', paid_at = ?, provider = ?, provider_reference = ?, hold_expires_at = '', updated_at = ? WHERE reference = ? AND status = 'PENDING_PAYMENT'",
    [stamp, String(input.provider || ""), String(input.transactionId || ""), stamp, reference],
  );
  if (Number(confirmed?.affected_row_count || 0) !== 1) {
    return { handled: true, status: "ALREADY_PAID" as const, booking: await getHostelBookingByReference(reference) };
  }
  await turso("UPDATE hostel_spaces SET status = 'OCCUPIED', updated_at = ? WHERE id = ?", [stamp, booking.spaceId]);
  await turso(
    `INSERT INTO hostel_payouts (id,booking_id,landlord_id,gross_amount,commission_bps,commission_amount,net_amount,status,release_after,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'ACCRUED',?,?,?) ON CONFLICT(booking_id) DO NOTHING`,
    [
      crypto.randomUUID(), booking.id, booking.landlordId, booking.totalAmount, booking.commissionBps, booking.commissionAmount, booking.netAmount,
      releaseAfterFor(booking.periodStartsOn), stamp, stamp,
    ],
  );
  await incrementMetric("hostel_booking_paid");
  await notifyHostelBookingConfirmed(booking).catch(() => undefined);
  const settled = await getHostelBookingByReference(reference);
  if (settled) await recordHostelBookingSystemMessage(settled).catch(() => undefined);
  await consoleAudit({
    actor: input.source, action: "HOSTEL_BOOKING_PAID", targetType: "hostel_booking", targetReference: reference,
    details: { amount: booking.totalAmount, commission: booking.commissionAmount, net: booking.netAmount },
  }).catch(() => undefined);
  return { handled: true, status: "PAID" as const, booking: await getHostelBookingByReference(reference) };
}

/** The one-hour payment cookie's hash, for authorising a guest checkout return. */
export async function hostelBookingAuthHash(reference: string) {
  await ensureHostelResidencyTables();
  const row = rowsToObjects(await turso("SELECT access_token_hash FROM hostel_bookings WHERE reference = ? LIMIT 1", [String(reference || "")]))[0];
  return String(row?.access_token_hash || "");
}

/** A charge that failed frees the bed immediately rather than waiting out the hold. */
export async function failHostelBooking(reference: string) {
  await ensureHostelResidencyTables();
  const booking = await getHostelBookingByReference(String(reference || ""));
  if (!booking || booking.status !== "PENDING_PAYMENT") return { handled: false };
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_bookings SET status = 'EXPIRED', hold_expires_at = '', updated_at = ? WHERE reference = ?", [stamp, booking.reference]);
  await turso("UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ? WHERE id = ? AND status = 'RESERVED'", [stamp, booking.spaceId]);
  await incrementMetric("hostel_booking_failed");
  return { handled: true };
}

/**
 * Paystack has been asked and says the checkout was never paid, so the hold is
 * released now rather than at the end of its grace. Only the reconcile sweep may
 * call this, because it is the check that makes the release safe.
 */
export async function expireHostelBooking(reference: string) {
  await ensureHostelResidencyTables();
  const booking = await getHostelBookingByReference(String(reference || ""));
  if (!booking || booking.status !== "PENDING_PAYMENT") return { handled: false };
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_bookings SET status = 'EXPIRED', hold_expires_at = '', updated_at = ? WHERE reference = ? AND status = 'PENDING_PAYMENT'", [stamp, booking.reference]);
  await turso("UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ? WHERE id = ? AND status = 'RESERVED'", [stamp, booking.spaceId]);
  await incrementMetric("hostel_hold_expired");
  return { handled: true };
}

async function notifyHostelBookingConfirmed(booking: HostelBooking) {
  const stay = `${booking.propertyName}${booking.roomLabel ? `, Room ${booking.roomLabel}` : ""}${booking.spaceLabel ? ` bed ${booking.spaceLabel}` : ""}`;
  await queueNotification(turso, {
    recipient: booking.studentEmail,
    template: "hostel_booking_confirmed",
    subject: `Your hostel bed is confirmed (${booking.reference})`,
    message: `Your payment for ${stay} in ${booking.periodName} is confirmed. The room is yours from ${booking.periodStartsOn}. Open your resident page to message the landlord and add services like water, power or laundry.`,
    reference: booking.reference,
    nowIso: new Date().toISOString(),
  });
  if (booking.landlordEmail) {
    await queueNotification(turso, {
      recipient: booking.landlordEmail,
      template: "hostel_booking_landlord",
      subject: `New paid resident at ${booking.propertyName}`,
      message: `${booking.studentName || booking.studentEmail} paid ${(booking.totalAmount / 100).toFixed(2)} for ${stay} in ${booking.periodName}. Your share is ${(booking.netAmount / 100).toFixed(2)}. Reply from the console.`,
      reference: `${booking.reference}:host`,
      nowIso: new Date().toISOString(),
    });
  }
}

/**
 * A booking lands in the thread so the history explains the money: the resident
 * opens the chat and sees what was paid and when, before saying anything.
 */
export async function recordHostelBookingSystemMessage(booking: HostelBooking) {
  await ensureHostelMessageTables();
  const stay = `${booking.propertyName}${booking.roomLabel ? `, Room ${booking.roomLabel}` : ""}${booking.spaceLabel ? ` bed ${booking.spaceLabel}` : ""}`;
  await turso(
    `INSERT INTO hostel_messages (id,booking_id,sender_type,sender_id,sender_name,content,metadata,read_at,created_at)
     VALUES (?,?,'SYSTEM','','UMaTeXPRESS',?,'',?,?)`,
    [
      crypto.randomUUID(), booking.id,
      `Payment received. ${stay} is reserved for ${booking.periodName}. The platform keeps ${(booking.commissionAmount / 100).toFixed(2)} and the landlord's share is ${(booking.netAmount / 100).toFixed(2)}.`,
      new Date().toISOString(), new Date().toISOString(),
    ],
  ).catch(() => undefined);
}
