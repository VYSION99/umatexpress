import { isProviderOutcomeUnknown } from "@/lib/payments/operations";
import { migrateHostelInventory, bedAvailableSql } from "./inventory";
import { migrateHostelStays } from "@/lib/hostel-engine/stay-schema";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { ownerReadiness } from "@/lib/hostel-engine/onboarding";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables, HOSTEL_DEFAULT_COMMISSION_BPS } from "@/lib/hostel-engine/landlord";
import { ensureHostelMessageTables } from "@/lib/hostel-engine/message-schema";
import { ESCROW_FLOOR_DAYS, hostelReleaseAfter } from "@/lib/hostel-engine/periods";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric, logEvent } from "@/lib/observability";
import { hashPaymentToken } from "@/lib/payment-access";
import { calculatePaystackCharge, getPaystackFeePercentRuntime, initializePaystackTransaction } from "@/lib/paystack";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";

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
    await migrateHostelStays();
    await migrateHostelInventory();
  })().catch(error => { residencyTablesReady = null; throw error; });
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
  processingFee: number;
  commissionBps: number;
  commissionAmount: number;
  netAmount: number;
  status: HostelBookingStatus;
  stayStatus: string;
  expectedArrivalOn: string;
  checkedInAt: string;
  checkedOutAt: string;
  stayVersion: number;
  holdExpiresAt: string;
  paidAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export const BOOKING_COLUMNS = `b.id,b.reference,b.listing_id,b.space_id,b.room_id,b.property_id,b.landlord_id,b.period_id,
  b.student_email,b.student_name,b.student_phone,b.price,b.utilities_fee,b.total_amount,b.commission_bps,
  b.commission_amount,b.net_amount,b.status,b.hold_expires_at,b.paid_at,b.note,b.created_at,b.updated_at,
  COALESCE(p.name,'') AS property_name,COALESCE(p.address,'') AS property_address,
  COALESCE(r.label,'') AS room_label,COALESCE(s.label,'') AS space_label,
  COALESCE(pe.name,'') AS period_name,COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.ends_on,'') AS period_ends_on,
  COALESCE(st.status,'EXPECTED') AS stay_status,COALESCE(st.expected_arrival_on,pe.starts_on,'') AS expected_arrival_on,
  COALESCE(st.checked_in_at,'') AS checked_in_at,COALESCE(st.checked_out_at,'') AS checked_out_at,COALESCE(st.version,0) AS stay_version,
  COALESCE(h.name,'') AS landlord_name,COALESCE(h.phone,'') AS landlord_phone,COALESCE(h.email,'') AS landlord_email`;

export const BOOKING_JOINS = `FROM hostel_bookings b
  LEFT JOIN hostel_properties p ON p.id = b.property_id
  LEFT JOIN hostel_rooms r ON r.id = b.room_id
  LEFT JOIN hostel_spaces s ON s.id = b.space_id
  LEFT JOIN hostel_periods pe ON pe.id = b.period_id
  LEFT JOIN hostel_landlords h ON h.id = b.landlord_id
  LEFT JOIN hostel_stays st ON st.booking_id = b.id`;

export function bookingView(row: Record<string, unknown>): HostelBooking {
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
    processingFee: Math.max(0, Number(row.total_amount || 0) - Number(row.price || 0) - Number(row.utilities_fee || 0)),
    commissionBps: Number(row.commission_bps || HOSTEL_DEFAULT_COMMISSION_BPS),
    commissionAmount: Number(row.commission_amount || 0),
    netAmount: Number(row.net_amount || 0),
    status: String(row.status || "PENDING_PAYMENT") as HostelBookingStatus,
    stayStatus: String(row.stay_status || "EXPECTED"),
    expectedArrivalOn: String(row.expected_arrival_on || row.period_starts_on || ""),
    checkedInAt: String(row.checked_in_at || ""),
    checkedOutAt: String(row.checked_out_at || ""),
    stayVersion: Number(row.stay_version || 0),
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
 * What the ledger stores for a booking: the documented escrow rule as a
 * timestamp, so a landlord is paid shortly before the year they let begins
 * rather than the day the student pays.
 *
 * `hostelReleaseAfter` owns that rule — three days before the year starts, or
 * seven days after the student actually paid, whichever is later — and this
 * wrapper adds only the tolerance a settlement needs. It runs after the money
 * has been taken, so a period date that cannot be parsed falls back to the
 * escrow floor instead of failing a payment that already succeeded. Writing the
 * day at midnight keeps one format in the column whichever branch ruled.
 */
export function releaseAfterFor(periodStartsOn: unknown, confirmedAt?: string, now = new Date()) {
  try {
    return `${hostelReleaseAfter(String(periodStartsOn || ""), confirmedAt)}T00:00:00.000Z`;
  } catch {
    return new Date(now.getTime() + ESCROW_FLOOR_DAYS * 24 * 60 * 60_000).toISOString();
  }
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
  const stamp = new Date().toISOString();
  const [expired, released] = await tursoTransaction([
    { sql: "UPDATE hostel_bookings SET status = 'EXPIRED', updated_at = ? WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <> '' AND hold_expires_at < ?", args: [stamp, now] },
    { sql: `UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ? WHERE status='RESERVED'
      AND id IN (SELECT space_id FROM hostel_bookings WHERE status='EXPIRED' AND updated_at=?)
      AND NOT EXISTS (SELECT 1 FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id WHERE b.space_id=hostel_spaces.id AND EXISTS(SELECT 1 FROM hostel_periods pe WHERE pe.id=b.period_id AND pe.starts_on<=date('now')) AND b.status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW') AND COALESCE(st.status,'EXPECTED') NOT IN ('CHECKED_OUT','NO_SHOW','CANCELLED'))`, args: [stamp, stamp] },
  ]);
  const count = Number(expired?.affected_row_count || 0);
  if (count) {
    await incrementMetric("hostel_holds_expired");
    logEvent("info", "hostel_holds_expired", { count, released: Number(released?.affected_row_count || 0) });
  }
  return count;
}

async function bookableListing(listingId: string) {
  const row = rowsToObjects(await turso(
    `SELECT l.id AS listing_id,l.status AS listing_status,l.space_id,l.period_id,l.price,
       CASE WHEN ${bedAvailableSql()} THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END AS space_status,COALESCE(s.label,'') AS space_label,
       r.id AS room_id,COALESCE(r.label,'') AS room_label,COALESCE(r.status,'ACTIVE') AS room_status,COALESCE(r.utilities_fee,0) AS utilities_fee,
       p.id AS property_id,COALESCE(p.name,'') AS property_name,COALESCE(p.status,'DRAFT') AS property_status,COALESCE(p.utilities_enabled,0) AS utilities_enabled,
       COALESCE(h.id,'') AS landlord_id,COALESCE(h.commission_bps,${HOSTEL_DEFAULT_COMMISSION_BPS}) AS commission_bps,COALESCE(h.status,'ACTIVE') AS landlord_status,
       COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.ends_on,'') AS period_ends_on,COALESCE(pe.active,0) AS period_active
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
  /** Internal frozen renewal offer. Never copied directly from a public booking body. */
  offer?: { id: string; version: number; price: number; utilitiesFee: number; guardSql: string; guardArgs: Array<string | number>; statements: (reference: string, stamp: string) => Array<{sql:string;args:Array<string|number|null>}> };
};

/**
 * Claims a bed and opens Paystack checkout. The claim is one conditional
 * UPDATE, so two students racing for the same bed cannot both win; the claim and booking insert commit together. Provider initialization runs
 * after commit, with compensation if checkout cannot be opened.
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
  if (String(listing.listing_status) !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "That bed is not approved for booking.", 409);
  if (String(listing.period_ends_on || "9999") < new Date().toISOString().slice(0,10)) throw new CampusEngineError("INVALID_STATE", "That academic year has ended.", 409);
  if (String(listing.period_active) !== "1") throw new CampusEngineError("INVALID_STATE", "That academic year is closed.", 409);
  if (String(listing.space_status) !== "AVAILABLE") throw new CampusEngineError("INVALID_STATE", "That bed has just been taken. Pick another one.", 409);
  if (String(listing.room_status) !== "ACTIVE" || String(listing.property_status) === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "That bed is not open for booking.", 409);
  }
  if (String(listing.landlord_status) !== "ACTIVE") throw new CampusEngineError("INVALID_STATE", "That landlord is not accepting bookings.", 409);
  if (String(listing.property_status) !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "That property is not approved for booking.", 409);
  const owner = await ownerReadiness(String(listing.landlord_id));
  if (owner.identityStatus !== "VERIFIED" || owner.profileStatus !== "APPROVED" || owner.payoutStatus !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "Booking is paused while owner verification or payout details are under review.", 409);
  const approvedPhoto = rowsToObjects(await turso("SELECT id FROM hostel_property_photos WHERE property_id=? AND status='APPROVED' LIMIT 1", [String(listing.property_id)]));
  if (!approvedPhoto.length) throw new CampusEngineError("INVALID_STATE", "Booking is paused while property photos are under review.", 409);

  const studentEmail = String(input.student.email || "").trim().toLowerCase();
  const alreadyResident = rowsToObjects(await turso(
    "SELECT reference FROM hostel_bookings WHERE student_email = ? AND period_id = ? AND status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW') AND id NOT IN (SELECT booking_id FROM hostel_stays WHERE status IN ('CHECKED_OUT','NO_SHOW','CANCELLED')) LIMIT 1",
    [studentEmail, String(listing.period_id)],
  ))[0];
  if (alreadyResident) {
    throw new CampusEngineError("CONFLICT", `You already have a booking or checkout for this year (${String(alreadyResident.reference)}).`, 409);
  }

  const stamp = new Date().toISOString();
  const price = Math.max(0, Math.round(Number(listing.price || 0)));
  const utilitiesFee = Number(listing.utilities_enabled ?? 0) === 1 ? Math.max(0, Math.round(Number(listing.utilities_fee || 0))) : 0;
  if (input.offer && (input.offer.price !== price || input.offer.utilitiesFee !== utilitiesFee)) throw new CampusEngineError("CONFLICT", "The renewal price changed. Ask staff for a new offer before paying.", 409);
  const split = splitHostelPayment(price + utilitiesFee, Number(listing.commission_bps || HOSTEL_DEFAULT_COMMISSION_BPS));
  const charge = calculatePaystackCharge(split.gross, await getPaystackFeePercentRuntime());
  const reference = bookingReference();
  const token = paymentToken();
  const holdExpiresAt = new Date(Date.now() + HOSTEL_HOLD_MINUTES * 60_000).toISOString();

  const [claimed, inserted] = await tursoTransaction([
    { sql: `UPDATE hostel_spaces SET status = CASE WHEN ?<=date('now') THEN 'RESERVED' ELSE status END, updated_at = ? WHERE id = ? AND ${bedAvailableSql('hostel_spaces',"'"+String(listing.period_id).replaceAll("'","''")+"'")}
      AND EXISTS(SELECT 1 FROM hostel_listings l JOIN hostel_rooms r ON r.id=hostel_spaces.room_id JOIN hostel_properties p ON p.id=r.property_id JOIN hostel_periods pe ON pe.id=l.period_id
      WHERE l.id=? AND l.status='APPROVED' AND l.price=? AND CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END=? AND r.status='ACTIVE' AND p.status='APPROVED' AND pe.active=1 AND pe.ends_on>=date('now'))
      ${input.offer ? 'AND ('+input.offer.guardSql+')' : ''}`,
      args: [String(listing.period_starts_on), stamp, String(listing.space_id),listingId,price,utilitiesFee,...(input.offer?.guardArgs||[])] },
    { sql: `INSERT INTO hostel_bookings (id,reference,listing_id,space_id,room_id,property_id,landlord_id,period_id,student_email,student_name,student_phone,
       price,utilities_fee,total_amount,commission_bps,commission_amount,net_amount,status,hold_expires_at,access_token_hash,note,created_at,updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING_PAYMENT',?,?,?,?,? WHERE changes() = 1`,
    args: [
      crypto.randomUUID(), reference, listingId, String(listing.space_id), String(listing.room_id), String(listing.property_id), String(listing.landlord_id),
      String(listing.period_id), studentEmail, String(input.student.name || "").slice(0, 100), String(input.student.phone || "").slice(0, 30),
      price, utilitiesFee, charge.totalAmount, split.commissionBps, split.commission, split.net, holdExpiresAt, await hashPaymentToken(token),
      String(input.note || "").slice(0, 300), stamp, stamp,
    ] },
    ...(input.offer?.statements(reference,stamp)||[]),
  ]).catch(error => {
    if (error instanceof Error && (error.message.includes("HOSTEL_ACTIVE_STUDENT_BOOKING") || error.message.includes("hostel_bed_claims"))) {
      throw new CampusEngineError("CONFLICT", "You already have a booking or checkout for this academic year. Open your residency to continue.", 409);
    }
    throw error;
  });
  if (Number(claimed.affected_row_count) !== 1 || Number(inserted.affected_row_count) !== 1) {
    throw new CampusEngineError("INVALID_STATE", "That bed has just been taken. Pick another one.", 409);
  }

  try {
    const paystack = await initializePaystackTransaction({
      email: studentEmail,
      amount: charge.totalAmount,
      reference,
      callbackUrl: `${input.origin}/hostel/resident?reference=${encodeURIComponent(reference)}`,
      metadata: { purpose: "HOSTEL_BOOKING", reference, propertyId: String(listing.property_id), spaceId: String(listing.space_id), baseAmount: split.gross, paystackFee: charge.feeAmount },
    });
    await incrementMetric("hostel_booking_started");
    const booking = await getHostelBookingByReference(reference);
    return { booking, authorizationUrl: paystack.authorizationUrl, token, secure: input.secure, holdMinutes: HOSTEL_HOLD_MINUTES };
  } catch (error) {
    if (isProviderOutcomeUnknown(error)) return { booking: await getHostelBookingByReference(reference), authorizationUrl: "", token, secure: input.secure, holdMinutes: HOSTEL_HOLD_MINUTES };
    // A definite refusal releases the hold.
    await failHostelBooking(reference).catch(() => undefined);
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
 * reference, and retries repair any missing historical ledger or stay record.
 * A payment that does not match the quoted total is held for review — the bed
 * stays reserved and an administrator decides, because releasing it would take
 * a bed from a student whose money did arrive.
 */
export async function settleHostelBooking(input: { reference: string; amount: number; currency?: string; transactionId?: string; provider?: string; source: string }) {
  await ensureHostelResidencyTables();
  const reference = String(input.reference || "").trim();
  const booking = await getHostelBookingByReference(reference);
  if (!booking) return { handled: false, reason: "BOOKING_NOT_FOUND" as const };
  if (booking.status === "PAID") {
    await tursoTransaction([
      { sql: `INSERT INTO hostel_payouts (id,booking_id,landlord_id,gross_amount,commission_bps,commission_amount,net_amount,status,release_after,created_at,updated_at)
        SELECT ?,id,landlord_id,price+utilities_fee,commission_bps,commission_amount,net_amount,'ACCRUED',?,?,? FROM hostel_bookings WHERE id=? AND status='PAID'
        ON CONFLICT(booking_id) DO NOTHING`, args: [crypto.randomUUID(), releaseAfterFor(booking.periodStartsOn, booking.paidAt), booking.paidAt || new Date().toISOString(), new Date().toISOString(), booking.id] },
      { sql: "INSERT INTO hostel_stays (booking_id,expected_arrival_on,updated_at) SELECT id,?,? FROM hostel_bookings WHERE id=? AND status='PAID' ON CONFLICT(booking_id) DO NOTHING", args: [booking.periodStartsOn, new Date().toISOString(), booking.id] },
      { sql: `UPDATE hostel_spaces SET status='OCCUPIED',updated_at=? WHERE id=? AND status='RESERVED' AND ?<=date('now')
        AND EXISTS (SELECT 1 FROM hostel_bookings b JOIN hostel_stays st ON st.booking_id=b.id WHERE b.id=? AND b.status='PAID' AND st.status IN ('EXPECTED','CHECKED_IN'))
        AND NOT EXISTS (SELECT 1 FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id WHERE b.space_id=hostel_spaces.id AND b.id<>?
          AND b.status IN ('PENDING_PAYMENT','PAYMENT_REVIEW','PAID') AND COALESCE(st.status,'EXPECTED') IN ('EXPECTED','CHECKED_IN'))`,
        args: [new Date().toISOString(), booking.spaceId, booking.periodStartsOn, booking.id, booking.id] },
    ]);
    return { handled: true, status: "ALREADY_PAID" as const, booking };
  }

  const stamp = new Date().toISOString();
  // Money that arrives after the bed was given back is not silently dropped:
  // the student paid, so the booking is flagged for a person to resolve.
  if (booking.status === "EXPIRED" || booking.status === "CANCELLED") {
    if (Number(input.amount || 0) > 0) {
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

  if (Math.round(Number(input.amount || 0)) !== booking.totalAmount || (input.currency && input.currency !== "GHS")) {
    await turso(
      "UPDATE hostel_bookings SET status = 'PAYMENT_REVIEW', paid_at = ?, provider = ?, provider_reference = ?, updated_at = ? WHERE reference = ? AND status='PENDING_PAYMENT'",
      [stamp, String(input.provider || ""), String(input.transactionId || ""), stamp, reference],
    );
    await incrementMetric("hostel_payment_review");
    logEvent("warn", "hostel_payment_amount_mismatch", { reference, expected: booking.totalAmount, received: Number(input.amount || 0), source: input.source });
    return { handled: true, status: "PAYMENT_REVIEW" as const, booking: await getHostelBookingByReference(reference) };
  }

  // Only one writer may turn a held bed into a residency: the loser of the race
  // returns the booking it read, without touching the bed, the ledger or the
  // thread a second time.
  const [confirmed] = await tursoTransaction([
    { sql: `UPDATE hostel_bookings SET status = 'PAID', paid_at = ?, provider = ?, provider_reference = ?, hold_expires_at = '', updated_at = ?
      WHERE reference = ? AND status = 'PENDING_PAYMENT'
      AND EXISTS (SELECT 1 FROM hostel_bed_claims c WHERE c.booking_id=hostel_bookings.id AND c.space_id=hostel_bookings.space_id AND c.period_id=hostel_bookings.period_id)
      AND NOT EXISTS (SELECT 1 FROM hostel_bookings other LEFT JOIN hostel_stays st ON st.booking_id=other.id
        WHERE other.id<>hostel_bookings.id AND other.status='PAID' AND COALESCE(st.status,'EXPECTED') NOT IN ('CHECKED_OUT','NO_SHOW','CANCELLED')
        AND ((other.student_email=hostel_bookings.student_email AND other.period_id=hostel_bookings.period_id) OR (other.space_id=hostel_bookings.space_id AND other.period_id=hostel_bookings.period_id)))`,
      args: [stamp, String(input.provider || ""), String(input.transactionId || ""), stamp, reference] },
    { sql: "UPDATE hostel_spaces SET status = CASE WHEN ?<=date('now') THEN 'OCCUPIED' ELSE status END, updated_at = ? WHERE id = ? AND changes() = 1", args: [booking.periodStartsOn, stamp, booking.spaceId] },
    { sql: `INSERT INTO hostel_payouts (id,booking_id,landlord_id,gross_amount,commission_bps,commission_amount,net_amount,status,release_after,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'ACCRUED',?,?,? WHERE changes() = 1 ON CONFLICT(booking_id) DO NOTHING`,
      args: [crypto.randomUUID(), booking.id, booking.landlordId, booking.price + booking.utilitiesFee, booking.commissionBps, booking.commissionAmount, booking.netAmount, releaseAfterFor(booking.periodStartsOn, stamp), stamp, stamp] },
    { sql: "INSERT INTO hostel_stays (booking_id,expected_arrival_on,updated_at) SELECT id,?,? FROM hostel_bookings WHERE id=? AND status='PAID' ON CONFLICT(booking_id) DO NOTHING", args: [booking.periodStartsOn, stamp, booking.id] },
  ]);
  if (Number(confirmed?.affected_row_count || 0) !== 1) {
    await turso("UPDATE hostel_bookings SET status='PAYMENT_REVIEW',paid_at=?,updated_at=? WHERE id=? AND status='PENDING_PAYMENT'", [stamp, stamp, booking.id]);
    const current = await getHostelBookingByReference(reference);
    return { handled: true, status: current?.status === "PAID" ? "ALREADY_PAID" as const : "PAYMENT_REVIEW" as const, booking: current };
  }
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
  return expireHostelBooking(reference);
}

/** Releases only this still-pending checkout and its own reserved space. */
export async function expireHostelBooking(reference: string) {
  await ensureHostelResidencyTables();
  const booking = await getHostelBookingByReference(String(reference || ""));
  if (!booking || booking.status !== "PENDING_PAYMENT") return { handled: false };
  const stamp = new Date().toISOString();
  const [expired] = await tursoTransaction([
    { sql: "UPDATE hostel_bookings SET status = 'EXPIRED', hold_expires_at = '', updated_at = ? WHERE reference = ? AND status = 'PENDING_PAYMENT'", args: [stamp, booking.reference] },
    { sql: `UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = ? WHERE id = ? AND status = 'RESERVED' AND changes() = 1
      AND NOT EXISTS(SELECT 1 FROM hostel_bed_claims c JOIN hostel_periods pe ON pe.id=c.period_id WHERE c.space_id=hostel_spaces.id AND pe.starts_on<=date('now'))`, args: [stamp, booking.spaceId] },
  ]);
  return { handled: Number(expired.affected_row_count) === 1 };
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
