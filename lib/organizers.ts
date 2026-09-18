import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import {
  assertConsolePassword,
  createConsoleAccount,
  ensureConsoleAccountsTable,
  revokeConsoleSessions,
} from "@/lib/console-auth";
import { ensureScheduledTripsTable } from "@/lib/dynamic-trips";
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
  reviewStatus: string;
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

const ORGANIZER_SCHEMA_VERSION = "2026-09-18.1";

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
  "CREATE INDEX IF NOT EXISTS idx_trip_organizers_status ON trip_organizers(status)",
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
 * Phase 2 has no organizer-created trips, so an admin hands over an existing
 * one. Only an approved organizer may own a trip, and an empty `organizerId`
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
       COALESCE(t.review_status,'DRAFT') AS review_status,COALESCE(t.archived,0) AS archived,
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
    reviewStatus: String(row.review_status || "DRAFT"),
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

export async function getOrganizerNotice(organizerId: string): Promise<FlyerPromo> {
  await ensureOrganizerTables();
  const row = rowsToObjects(await turso(
    "SELECT enabled,title,route,fare,night_bus,day_buses,drop_off_points,amenities,contacts FROM trip_notices WHERE organizer_id = ? LIMIT 1",
    [organizerId],
  ))[0];
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
