import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import {
  assertConsolePassword,
  createConsoleAccount,
  ensureConsoleAccountsTable,
  revokeConsoleSessions,
} from "@/lib/console-auth";
import { ensureScheduledTripsTable } from "@/lib/dynamic-trips";
import { lastFour, maskAccountNumber, openSecret, sealSecret } from "@/lib/secret-box";
import { findPayoutDestination, isPayoutMethod, type PayoutMethod } from "@/lib/paystack-banks";
import { EMPTY_FLYER_PROMO, normalizeFlyerPromo, type FlyerPromo } from "@/lib/trip-notice";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Organizer accounts and trip ownership.
 *
 * Two gates live on two records and must be moved together. The console account
 * is what a person signs in with (`PENDING | ACTIVE | SUSPENDED`) and the
 * organizer record is the business (`PENDING | APPROVED | REJECTED |
 * SUSPENDED`). A rejected application keeps its console account PENDING so it
 * still cannot sign in; only approval makes the account ACTIVE.
 *
 * Ownership never comes from a request. Every function below takes the
 * organizer id from the caller, which reads it from the signed session, and
 * every trip lookup puts that id in the WHERE clause so one organizer cannot
 * reach another's rows even with a valid trip id.
 */
export const ORGANIZER_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"] as const;
export type OrganizerStatus = (typeof ORGANIZER_STATUSES)[number];

export type Organizer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  organization: string;
  status: OrganizerStatus;
  kycStatus: string;
  commissionBps: number;
  createdAt: string;
  updatedAt: string;
  accountId: string;
  accountStatus: string;
};

export type OrganizerTrip = {
  id: string;
  title: string;
  from: string;
  to: string;
  travelDate: string;
  departureTime: string;
  arrivalTime: string;
  price: number;
  capacity: number;
  coachType: string;
  tag: string;
  amenities: string[];
  notes: string;
  reviewStatus: string;
  /** Why a reviewer sent it back, so the organizer knows what to change. */
  reviewReason: string;
  archived: boolean;
  bookingCount: number;
  confirmedCount: number;
};

export type ManifestPassenger = {
  reference: string;
  name: string;
  seat: number;
  phone: string;
  bookingStatus: string;
  travelDate: string;
  createdAt: string;
};

const ORGANIZER_SCHEMA_VERSION = "2026-09-18.3";

const ORGANIZER_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trip_organizers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    organization TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'PENDING',
    kyc_status TEXT NOT NULL DEFAULT 'PENDING',
    payout_method TEXT NOT NULL DEFAULT '',
    payout_account_name TEXT NOT NULL DEFAULT '',
    payout_account_number TEXT NOT NULL DEFAULT '',
    payout_bank_code TEXT NOT NULL DEFAULT '',
    payout_bank_name TEXT NOT NULL DEFAULT '',
    paystack_recipient_code TEXT NOT NULL DEFAULT '',
    commission_bps INTEGER NOT NULL DEFAULT 300,
    review_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trip_notices (
    organizer_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    route TEXT NOT NULL DEFAULT '',
    fare TEXT NOT NULL DEFAULT '',
    night_bus TEXT NOT NULL DEFAULT '',
    day_buses TEXT NOT NULL DEFAULT '',
    drop_off_points TEXT NOT NULL DEFAULT '',
    amenities TEXT NOT NULL DEFAULT '',
    contacts TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  "ALTER TABLE trip_organizers ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trip_organizers ADD COLUMN kyc_id_type TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trip_organizers ADD COLUMN kyc_id_number TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trip_organizers ADD COLUMN kyc_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trip_organizers ADD COLUMN kyc_submitted_at TEXT",
  "ALTER TABLE trip_organizers ADD COLUMN kyc_reviewed_at TEXT",
  "ALTER TABLE trip_organizers ADD COLUMN payout_account_last4 TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trip_organizers ADD COLUMN payout_updated_at TEXT",
  // A Paystack transfer is addressed by a bank_code, so the account number
  // alone was never enough to actually pay anyone.
  "ALTER TABLE trip_organizers ADD COLUMN payout_bank_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trip_organizers ADD COLUMN payout_bank_name TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_trip_organizers_status ON trip_organizers(status)",
  "CREATE INDEX IF NOT EXISTS idx_trip_organizers_kyc ON trip_organizers(kyc_status, status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_organizers_phone ON trip_organizers(phone) WHERE phone <> ''",
];

let organizerTablesReady: Promise<void> | null = null;

export function ensureOrganizerTables() {
  organizerTablesReady ??= (async () => {
    // The list view joins the console account, so both tables must exist.
    await ensureConsoleAccountsTable();
    await runSchemaPass({
      metaTable: "campus_schema_meta",
      id: "tripOrganizers",
      version: ORGANIZER_SCHEMA_VERSION,
      statements: ORGANIZER_SCHEMA_STATEMENTS,
    });
  })().catch((error: unknown) => {
    organizerTablesReady = null;
    throw error;
  });
  return organizerTablesReady;
}

function columns(alias: string) {
  return `${alias}.id,${alias}.name,${alias}.phone,${alias}.email,COALESCE(${alias}.organization,'') AS organization,${alias}.status,COALESCE(${alias}.kyc_status,'PENDING') AS kyc_status,COALESCE(${alias}.commission_bps,300) AS commission_bps,${alias}.created_at,${alias}.updated_at`;
}

function organizerView(row: Record<string, unknown>): Organizer {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    email: String(row.email || ""),
    organization: String(row.organization || ""),
    status: String(row.status || "PENDING") as OrganizerStatus,
    kycStatus: String(row.kyc_status || "PENDING"),
    commissionBps: Number(row.commission_bps ?? 300),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    accountId: String(row.account_id || ""),
    accountStatus: String(row.account_status || ""),
  };
}

/**
 * `amenities` is stored as JSON text. A row written by hand or by an older
 * version may hold a comma-separated list instead, so a parse failure falls
 * back to splitting rather than throwing the whole trip list away.
 */
function amenityList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  const text = String(value ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return text.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

export async function getOrganizer(organizerId: string): Promise<Organizer | null> {
  await ensureOrganizerTables();
  const row = rowsToObjects(await turso(
    `SELECT ${columns("o")}, COALESCE(a.id,'') AS account_id, COALESCE(a.status,'') AS account_status
     FROM trip_organizers o LEFT JOIN console_accounts a ON a.profile_id = o.id AND a.role = 'ORGANIZER'
     WHERE o.id = ? LIMIT 1`,
    [organizerId],
  ))[0];
  return row ? organizerView(row) : null;
}

export async function listOrganizers(filter: { status?: string } = {}) {
  await ensureOrganizerTables();
  const status = String(filter.status || "").trim().toUpperCase();
  const rows = rowsToObjects(await turso(
    `SELECT ${columns("o")}, COALESCE(a.id,'') AS account_id, COALESCE(a.status,'') AS account_status
     FROM trip_organizers o LEFT JOIN console_accounts a ON a.profile_id = o.id AND a.role = 'ORGANIZER'
     WHERE (? = '' OR o.status = ?)
     ORDER BY CASE o.status WHEN 'PENDING' THEN 0 ELSE 1 END, o.created_at DESC`,
    [status, status],
  ));
  return rows.map(organizerView);
}

/**
 * Open registration with a mandatory approval gate. The organizer record is
 * written first because the console account points at it; if the account cannot
 * be created the record is removed again rather than leaving an application
 * nobody can sign in to.
 */
export async function registerOrganizer(input: {
  name?: unknown; phone?: unknown; email?: unknown; password?: unknown; organization?: unknown;
}) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Organizer registration is not available on this deployment.", 503);
  }
  const name = String(input.name || "").trim();
  const phone = String(input.phone || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const organization = String(input.organization || "").trim();
  const password = String(input.password || "");
  if (!name || !phone || !email) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter your name, phone number and email address.", 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter a valid email address.", 400);
  }
  // Same policy the role will be held to once the account is active.
  assertConsolePassword("ORGANIZER", password);
  await ensureOrganizerTables();

  const duplicate = rowsToObjects(await turso(
    "SELECT id FROM trip_organizers WHERE email = ? OR phone = ? LIMIT 1",
    [email, phone],
  ))[0];
  if (duplicate) {
    throw new CampusEngineError("CONFLICT", "An application already exists for that email address or phone number.", 409);
  }
  const taken = rowsToObjects(await turso("SELECT id FROM console_accounts WHERE email = ? LIMIT 1", [email]))[0];
  if (taken) {
    throw new CampusEngineError("CONFLICT", "That email address is already registered.", 409);
  }

  const stamp = new Date().toISOString();
  const organizerId = crypto.randomUUID();
  await turso(
    "INSERT INTO trip_organizers (id,name,phone,email,organization,status,commission_bps,created_at,updated_at) VALUES (?,?,?,?,?, 'PENDING', 300, ?, ?)",
    [organizerId, name, phone, email, organization, stamp, stamp],
  );
  let accountId = "";
  try {
    accountId = await createConsoleAccount({
      email, password, name, phone, role: "ORGANIZER", profileId: organizerId, status: "PENDING",
    });
  } catch (error) {
    await turso("DELETE FROM trip_organizers WHERE id = ?", [organizerId]).catch(() => undefined);
    throw error;
  }

  await consoleAudit({
    actor: email,
    action: "ORGANIZER_APPLIED",
    targetType: "trip_organizer",
    targetReference: organizerId,
    details: { organization },
  }).catch(() => undefined);

  return { organizerId, accountId, status: "PENDING" as const };
}

/**
 * Moves an application through the gate. `APPROVE` activates the console
 * account; `SUSPEND` takes it away and revokes live sessions, so a suspended
 * organizer loses access on the next request rather than when the cookie
 * expires. `REJECT` closes the application but leaves the account unable to
 * sign in, because only approval ever makes it ACTIVE.
 */
export async function setOrganizerStatus(input: {
  organizerId: string;
  action: "APPROVE" | "REJECT" | "SUSPEND";
  reason?: string;
  actor: string;
}) {
  await ensureOrganizerTables();
  const organizer = await getOrganizer(input.organizerId);
  if (!organizer) throw new CampusEngineError("NOT_FOUND", "That organizer application was not found.", 404);

  const stamp = new Date().toISOString();
  const reason = String(input.reason || "").trim();
  if (input.action === "REJECT" && !reason) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give a reason so the applicant knows what to fix.", 400);
  }

  if (input.action === "APPROVE") {
    await turso("UPDATE trip_organizers SET status = 'APPROVED', review_reason = '', updated_at = ? WHERE id = ?", [stamp, organizer.id]);
    if (organizer.accountId) {
      await turso("UPDATE console_accounts SET status = 'ACTIVE', updated_at = ? WHERE id = ?", [stamp, organizer.accountId]);
    }
  } else if (input.action === "REJECT") {
    await turso("UPDATE trip_organizers SET status = 'REJECTED', review_reason = ?, updated_at = ? WHERE id = ?", [reason, stamp, organizer.id]);
  } else {
    await turso("UPDATE trip_organizers SET status = 'SUSPENDED', review_reason = ?, updated_at = ? WHERE id = ?", [reason, stamp, organizer.id]);
    if (organizer.accountId) {
      await turso("UPDATE console_accounts SET status = 'SUSPENDED', updated_at = ? WHERE id = ?", [stamp, organizer.accountId]);
      await revokeConsoleSessions(organizer.accountId);
    }
    // Suspension covers the business, not only the sign-in. A live trip left
    // on sale would keep taking passenger money for an organizer the platform
    // has just stopped doing business with, and the payout gate would hold that
    // money instead of paying it. Every live trip makes the same
    // APPROVED -> SUSPENDED move an administrator can make by hand; a
    // reinstated organizer resubmits them for review rather than having them
    // silently return to sale.
    await ensureScheduledTripsTable();
    await turso(
      "UPDATE scheduled_trips SET review_status = 'SUSPENDED', review_reason = ?, reviewed_at = ?, reviewed_by = ?, active = 0, updated_at = ? WHERE organizer_id = ? AND review_status = 'APPROVED'",
      [reason, stamp, input.actor, stamp, organizer.id],
    );
  }

  await consoleAudit({
    actor: input.actor,
    action: `ORGANIZER_${input.action}`,
    targetType: "trip_organizer",
    targetReference: organizer.id,
    details: { from: organizer.status, reason },
  });
  return getOrganizer(organizer.id);
}

/**
 * Hands an existing platform trip to an organizer. Organizers publish their
 * own trips from Phase 3 on; this is the admin path for the trips that predate
 * them. Only an approved organizer may own a trip, and an empty `organizerId`
 * returns the trip to the platform.
 */
export async function assignTripToOrganizer(input: { tripId: string; organizerId: string; actor: string }) {
  await ensureScheduledTripsTable();
  const tripId = String(input.tripId || "").trim();
  const organizerId = String(input.organizerId || "").trim();
  if (!tripId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a trip to assign.", 400);

  const trip = rowsToObjects(await turso("SELECT id FROM scheduled_trips WHERE id = ? LIMIT 1", [tripId]))[0];
  if (!trip) throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);

  if (organizerId) {
    const organizer = await getOrganizer(organizerId);
    if (!organizer) throw new CampusEngineError("NOT_FOUND", "That organizer was not found.", 404);
    if (organizer.status !== "APPROVED") {
      throw new CampusEngineError("INVALID_STATE", "Approve the organizer before assigning trips to them.", 409);
    }
  }

  await turso("UPDATE scheduled_trips SET organizer_id = ?, updated_at = ? WHERE id = ?", [organizerId || null, new Date().toISOString(), tripId]);
  await consoleAudit({
    actor: input.actor,
    action: organizerId ? "TRIP_ASSIGNED" : "TRIP_RELEASED",
    targetType: "scheduled_trip",
    targetReference: tripId,
    details: { organizerId },
  });
  return { tripId, organizerId };
}

/** The trips this organizer owns. The id comes from the session, never a request. */
export async function listOrganizerTrips(organizerId: string) {
  await ensureScheduledTripsTable();
  const rows = rowsToObjects(await turso(
    `SELECT t.id,t.title,t.route_from,t.route_to,t.travel_date,t.departure_time,t.arrival_time,t.price,t.capacity,t.coach_type,
       COALESCE(t.tag,'') AS tag,COALESCE(t.amenities,'') AS amenities,COALESCE(t.notes,'') AS notes,
       COALESCE(t.review_status,'DRAFT') AS review_status,COALESCE(t.archived,0) AS archived,
       COALESCE(t.review_reason,'') AS review_reason,
       (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id) AS booking_count,
       (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.booking_status = 'CONFIRMED') AS confirmed_count
     FROM scheduled_trips t WHERE t.organizer_id = ?
     ORDER BY t.travel_date ASC, t.departure_time ASC`,
    [organizerId],
  ));
  return rows.map((row): OrganizerTrip => ({
    id: String(row.id),
    title: String(row.title || ""),
    from: String(row.route_from || ""),
    to: String(row.route_to || ""),
    travelDate: String(row.travel_date || ""),
    departureTime: String(row.departure_time || ""),
    arrivalTime: String(row.arrival_time || ""),
    price: Number(row.price || 0),
    capacity: Number(row.capacity || 0),
    coachType: String(row.coach_type || ""),
    tag: String(row.tag || ""),
    amenities: amenityList(row.amenities),
    notes: String(row.notes || ""),
    reviewStatus: String(row.review_status || "DRAFT"),
    reviewReason: String(row.review_reason || ""),
    archived: Number(row.archived ?? 0) === 1,
    bookingCount: Number(row.booking_count || 0),
    confirmedCount: Number(row.confirmed_count || 0),
  }));
}

/**
 * Passenger contacts for one of the organizer's own trips (decision D3).
 *
 * A trip that exists but belongs to someone else is reported as missing, so an
 * organizer cannot probe for trip ids they do not own. Every read is audited
 * with the account, the trip and how many rows were returned.
 */
export async function getOrganizerManifest(input: { organizerId: string; tripId: string; actor: string }) {
  await ensureScheduledTripsTable();
  const tripId = String(input.tripId || "").trim();
  const trip = rowsToObjects(await turso(
    "SELECT id,title,route_from,route_to,travel_date,departure_time,arrival_time,capacity FROM scheduled_trips WHERE id = ? AND organizer_id = ? LIMIT 1",
    [tripId, input.organizerId],
  ))[0];
  if (!trip) throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);

  const passengers = rowsToObjects(await turso(
    "SELECT reference, passenger_name, seat, phone, booking_status, travel_date, created_at FROM bookings WHERE trip_id = ? ORDER BY seat ASC",
    [tripId],
  )).map((row): ManifestPassenger => ({
    reference: String(row.reference || ""),
    name: String(row.passenger_name || ""),
    seat: Number(row.seat || 0),
    phone: String(row.phone || ""),
    bookingStatus: String(row.booking_status || ""),
    travelDate: String(row.travel_date || ""),
    createdAt: String(row.created_at || ""),
  }));

  await consoleAudit({
    actor: input.actor,
    action: "ORGANIZER_MANIFEST_READ",
    targetType: "scheduled_trip",
    targetReference: tripId,
    details: { organizerId: input.organizerId, passengers: passengers.length },
  });

  return {
    trip: {
      id: String(trip.id),
      title: String(trip.title || ""),
      from: String(trip.route_from || ""),
      to: String(trip.route_to || ""),
      travelDate: String(trip.travel_date || ""),
      departureTime: String(trip.departure_time || ""),
      arrivalTime: String(trip.arrival_time || ""),
      capacity: Number(trip.capacity || 0),
    },
    passengers,
  };
}

function parseList(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [] as string[];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return [] as string[];
}

/** The public facing shape of a `trip_notices` row; shared with the carousel feed. */
export function noticeRowToPromo(row: Record<string, unknown> | undefined): FlyerPromo {
  if (!row) return EMPTY_FLYER_PROMO;
  return {
    enabled: Number(row.enabled ?? 0) === 1,
    title: String(row.title || ""),
    route: String(row.route || ""),
    fare: String(row.fare || ""),
    nightBus: String(row.night_bus || ""),
    dayBuses: parseList(row.day_buses),
    dropOffPoints: parseList(row.drop_off_points),
    amenities: parseList(row.amenities),
    contacts: parseList(row.contacts),
  };
}

export async function getOrganizerNotice(organizerId: string): Promise<FlyerPromo> {
  await ensureOrganizerTables();
  const row = rowsToObjects(await turso(
    "SELECT enabled,title,route,fare,night_bus,day_buses,drop_off_points,amenities,contacts FROM trip_notices WHERE organizer_id = ? LIMIT 1",
    [organizerId],
  ))[0];
  return noticeRowToPromo(row);
}

/** Partial updates merge onto the stored notice so an omitted field keeps its value. */
export async function saveOrganizerNotice(organizerId: string, patch: unknown) {
  await ensureOrganizerTables();
  const merged = normalizeFlyerPromo(patch, await getOrganizerNotice(organizerId));
  await turso(
    `INSERT INTO trip_notices (organizer_id,enabled,title,route,fare,night_bus,day_buses,drop_off_points,amenities,contacts,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(organizer_id) DO UPDATE SET enabled=excluded.enabled,title=excluded.title,route=excluded.route,fare=excluded.fare,night_bus=excluded.night_bus,day_buses=excluded.day_buses,drop_off_points=excluded.drop_off_points,amenities=excluded.amenities,contacts=excluded.contacts,updated_at=excluded.updated_at`,
    [
      organizerId,
      merged.enabled ? 1 : 0,
      merged.title,
      merged.route,
      merged.fare,
      merged.nightBus,
      JSON.stringify(merged.dayBuses),
      JSON.stringify(merged.dropOffPoints),
      JSON.stringify(merged.amenities),
      JSON.stringify(merged.contacts),
      new Date().toISOString(),
    ],
  );
  return merged;
}

/**
 * The notice a public trip should show: its organizer's, or null when the trip
 * has no organizer so the caller falls back to the platform notice.
 */
export async function organizerNoticeForTrip(tripId: string): Promise<FlyerPromo | null> {
  if (!(await isTursoConfiguredRuntime())) return null;
  const id = String(tripId || "").trim();
  if (!id) return null;
  await ensureOrganizerTables();
  const row = rowsToObjects(await turso(
    "SELECT COALESCE(organizer_id,'') AS organizer_id FROM scheduled_trips WHERE id = ? LIMIT 1",
    [id],
  ))[0];
  const organizerId = String(row?.organizer_id || "");
  if (!organizerId) return null;
  return getOrganizerNotice(organizerId);
}

export type OrganizerProfile = {
  organizerId: string;
  kycStatus: string;
  kycIdType: string;
  /** Masked. The full number is only ever returned by an audited reveal. */
  kycIdNumberMasked: string;
  kycReason: string;
  kycSubmittedAt: string;
  kycReviewedAt: string;
  payoutMethod: string;
  payoutAccountName: string;
  /** Masked. The full number is only ever returned by an audited reveal. */
  payoutAccountMasked: string;
  /** Which institution the number belongs to; the label is safe to show. */
  payoutBankCode: string;
  payoutBankName: string;
  payoutUpdatedAt: string;
  payoutRecipientReady: boolean;
};

const KYC_ACTIONS = ["VERIFY", "REJECT"] as const;
export type KycAction = (typeof KYC_ACTIONS)[number];
export function isKycAction(value: unknown): value is KycAction {
  return typeof value === "string" && (KYC_ACTIONS as readonly string[]).includes(value);
}

/**
 * The organizer's own KYC and payout record, always masked. Nothing here is
 * decryptable, so a page that renders this cannot leak an account number.
 */
export async function getOrganizerProfile(organizerId: string): Promise<OrganizerProfile | null> {
  await ensureOrganizerTables();
  const row = rowsToObjects(await turso(
    `SELECT id,COALESCE(kyc_status,'PENDING') AS kyc_status,COALESCE(kyc_id_type,'') AS kyc_id_type,
       COALESCE(kyc_id_number,'') AS kyc_id_number,COALESCE(kyc_reason,'') AS kyc_reason,
       COALESCE(kyc_submitted_at,'') AS kyc_submitted_at,COALESCE(kyc_reviewed_at,'') AS kyc_reviewed_at,
       COALESCE(payout_method,'') AS payout_method,COALESCE(payout_account_name,'') AS payout_account_name,
       COALESCE(payout_account_number,'') AS payout_account_number,
       COALESCE(payout_account_last4,'') AS payout_account_last4,COALESCE(payout_updated_at,'') AS payout_updated_at,
       COALESCE(payout_bank_code,'') AS payout_bank_code,COALESCE(payout_bank_name,'') AS payout_bank_name,
       COALESCE(paystack_recipient_code,'') AS paystack_recipient_code
     FROM trip_organizers WHERE id = ? LIMIT 1`,
    [organizerId],
  ))[0];
  if (!row) return null;
  // Older rows may predate the last4 column; fall back to reading the sealed
  // value rather than showing nothing.
  let last4 = String(row.payout_account_last4 || "");
  if (!last4 && row.payout_account_number) last4 = lastFour((await openSecret(row.payout_account_number)) || "");
  // KYC has no last4 column: the mask is derived from the sealed number, so a
  // submission shows as `••••1234` instead of an empty placeholder.
  const kycLast4 = last4Of(String(row.kyc_id_number || "")) || lastFour((await openSecret(row.kyc_id_number)) || "");
  return {
    organizerId: String(row.id),
    kycStatus: String(row.kyc_status || "PENDING"),
    kycIdType: String(row.kyc_id_type || ""),
    kycIdNumberMasked: maskAccountNumber(kycLast4),
    kycReason: String(row.kyc_reason || ""),
    kycSubmittedAt: String(row.kyc_submitted_at || ""),
    kycReviewedAt: String(row.kyc_reviewed_at || ""),
    payoutMethod: String(row.payout_method || ""),
    payoutAccountName: String(row.payout_account_name || ""),
    payoutAccountMasked: maskAccountNumber(last4),
    payoutBankCode: String(row.payout_bank_code || ""),
    payoutBankName: String(row.payout_bank_name || ""),
    payoutUpdatedAt: String(row.payout_updated_at || ""),
    payoutRecipientReady: Boolean(String(row.paystack_recipient_code || "")),
  };
}

/**
 * The last four digits of a sealed value, used only for masking. Reading the
 * sealed payload is cheap and avoids storing a second copy of the same secret.
 */
function last4Of(value: string) {
  const cleaned = String(value || "").trim();
  return /^\d{3,}$/.test(cleaned) ? lastFour(cleaned) : "";
}

export async function saveOrganizerKyc(organizerId: string, input: { idType?: unknown; idNumber?: unknown }) {
  await ensureOrganizerTables();
  const idType = String(input.idType || "").trim();
  const idNumber = String(input.idNumber || "").trim();
  if (!idType || !idNumber) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose an ID type and enter the ID number.", 400);
  }
  if (idNumber.length < 4 || idNumber.length > 40) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter the ID number as it appears on the document.", 400);
  }
  const stamp = new Date().toISOString();
  // Re-submitting after a rejection clears the old decision, so the record
  // never shows a rejection reason next to a fresh submission.
  await turso(
    `UPDATE trip_organizers SET kyc_id_type=?,kyc_id_number=?,kyc_status='PENDING',kyc_reason='',kyc_submitted_at=?,kyc_reviewed_at=NULL,updated_at=?
     WHERE id=?`,
    [idType, await sealSecret(idNumber), stamp, stamp, organizerId],
  );
  return getOrganizerProfile(organizerId);
}

export async function saveOrganizerPayoutAccount(organizerId: string, input: {
  method?: unknown; accountName?: unknown; accountNumber?: unknown; bankCode?: unknown;
}) {
  await ensureOrganizerTables();
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
  // The destination is part of the account, not a preference: a transfer
  // addressed to the wrong bank code reaches the wrong institution. It is
  // resolved against the catalogue so an unknown code cannot be stored.
  const destination = await findPayoutDestination(method as PayoutMethod, input.bankCode);
  if (!destination) {
    throw new CampusEngineError(
      "VALIDATION_ERROR",
      method === "BANK" ? "Choose the bank that holds this account." : "Choose the mobile money network.",
      400,
    );
  }
  const stamp = new Date().toISOString();
  // A recipient code is an address, and the address just changed. Clearing it
  // is what stops the next payout from being sent to the previous account.
  const previous = rowsToObjects(await turso(
    `SELECT COALESCE(payout_method,'') AS payout_method,COALESCE(payout_bank_code,'') AS payout_bank_code,
       COALESCE(payout_account_number,'') AS payout_account_number,COALESCE(payout_account_name,'') AS payout_account_name,
       COALESCE(paystack_recipient_code,'') AS paystack_recipient_code
     FROM trip_organizers WHERE id = ? LIMIT 1`,
    [organizerId],
  ))[0];
  const sealed = await sealSecret(accountNumber);
  const changed = !previous
    || String(previous.payout_method || "") !== method
    || String(previous.payout_bank_code || "") !== destination.code
    || String(previous.payout_account_name || "") !== accountName
    || String(previous.payout_account_number || "") !== sealed;
  await turso(
    `UPDATE trip_organizers SET payout_method=?,payout_account_name=?,payout_account_number=?,payout_account_last4=?,
       payout_bank_code=?,payout_bank_name=?,payout_updated_at=?,updated_at=?,paystack_recipient_code=?
     WHERE id=?`,
    [
      method, accountName, sealed, lastFour(accountNumber),
      destination.code, destination.name, stamp, stamp,
      changed ? "" : String(previous.paystack_recipient_code || ""),
      organizerId,
    ],
  );
  await consoleAudit({
    actor: organizerId,
    action: "ORGANIZER_PAYOUT_ACCOUNT_SAVED",
    targetType: "trip_organizer",
    targetReference: organizerId,
    // The last four are enough to recognise a change; the number itself is
    // deliberately never written to the audit trail.
    details: { method, last4: lastFour(accountNumber), destination: destination.name, recipientCleared: changed },
  }).catch(() => undefined);
  return getOrganizerProfile(organizerId);
}

/**
 * The one way to read a full number back. Every call is audited with the actor
 * and which fields were opened, so a reveal is never silent.
 */
export async function revealOrganizerProfile(organizerId: string, actor: string) {
  await ensureOrganizerTables();
  const row = rowsToObjects(await turso(
    "SELECT COALESCE(payout_account_number,'') AS payout_account_number, COALESCE(kyc_id_number,'') AS kyc_id_number FROM trip_organizers WHERE id = ? LIMIT 1",
    [organizerId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That organizer was not found.", 404);
  const revealed: Record<string, string> = {};
  const payout = await openSecret(row.payout_account_number);
  if (payout) revealed.payoutAccountNumber = payout;
  const kyc = await openSecret(row.kyc_id_number);
  if (kyc) revealed.kycIdNumber = kyc;
  await consoleAudit({
    actor,
    action: "ORGANIZER_PROFILE_REVEALED",
    targetType: "trip_organizer",
    targetReference: organizerId,
    details: { fields: Object.keys(revealed) },
  });
  return revealed;
}

/** KYC is a separate gate from account approval: it only decides whether money may leave. */
export async function reviewOrganizerKyc(input: {
  organizerId: string; action: KycAction; reason?: string; actor: string;
}) {
  await ensureOrganizerTables();
  const organizer = await getOrganizer(input.organizerId);
  if (!organizer) throw new CampusEngineError("NOT_FOUND", "That organizer was not found.", 404);
  if (organizer.status !== "APPROVED") {
    throw new CampusEngineError("INVALID_STATE", "Approve the organizer before reviewing their KYC.", 409);
  }
  const reason = String(input.reason || "").trim();
  if (input.action === "REJECT" && !reason) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give a reason so the organizer knows what to fix.", 400);
  }
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE trip_organizers SET kyc_status=?,kyc_reason=?,kyc_reviewed_at=?,updated_at=? WHERE id=?",
    [input.action === "VERIFY" ? "VERIFIED" : "REJECTED", input.action === "VERIFY" ? "" : reason, stamp, stamp, organizer.id],
  );
  await consoleAudit({
    actor: input.actor,
    action: `ORGANIZER_KYC_${input.action}`,
    targetType: "trip_organizer",
    targetReference: organizer.id,
    details: { from: organizer.kycStatus, reason },
  });
  return getOrganizer(organizer.id);
}

/**
 * Display names for the public trip list. Names only: never a contact, an
 * account number or a status.
 */
export async function organizerDisplayNames(ids: readonly string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!unique.length || !(await isTursoConfiguredRuntime())) return {};
  try {
    await ensureOrganizerTables();
    const placeholders = unique.map(() => "?").join(",");
    const rows = rowsToObjects(await turso(
      `SELECT id,COALESCE(NULLIF(organization,''),name) AS display_name FROM trip_organizers WHERE id IN (${placeholders})`,
      unique,
    ));
    return Object.fromEntries(rows.map((row) => [String(row.id), String(row.display_name || "")]));
  } catch {
    // An organizer name is a nicety on the public list; a database that has not
    // caught up must not take the trip list down with it.
    return {};
  }
}
