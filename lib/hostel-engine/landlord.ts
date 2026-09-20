import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { assertConsolePassword, createConsoleAccount, ensureConsoleAccountsTable } from "@/lib/console-auth";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Landlord accounts and their buildings.
 *
 * Two gates live on two records and move together, exactly like organizers:
 * the console account is what a person signs in with (`console_accounts`) and
 * the landlord record is the business (`hostel_landlords`). Landlord
 * registration is DIRECT — the account is ACTIVE at once so the landlord can
 * build the property — while a student only ever sees a listing after review,
 * so visibility is gated by the listing, never by the sign-up.
 *
 * Ownership never comes from a request. Every function below takes the landlord
 * id from the caller, which reads it from the signed session's profile id, and
 * every lookup puts that id in the WHERE clause so one landlord cannot reach
 * another's rows even with a valid property id.
 */

export const HOSTEL_SCHEMA_VERSION = "2026-09-20.1";

export const HOSTEL_PROPERTY_STATUSES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "SUSPENDED"] as const;
export type HostelPropertyStatus = (typeof HOSTEL_PROPERTY_STATUSES)[number];

export const HOSTEL_KYC_STATUSES = ["PENDING", "VERIFIED", "REJECTED"] as const;
export type HostelKycStatus = (typeof HOSTEL_KYC_STATUSES)[number];

export type HostelLandlord = {
  id: string;
  name: string;
  phone: string;
  email: string;
  organization: string;
  status: string;
  kycStatus: HostelKycStatus;
  commissionBps: number;
  reviewReason: string;
  createdAt: string;
  updatedAt: string;
};

export type HostelProperty = {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  campusDistanceM: number | null;
  utilitiesEnabled: boolean;
  status: HostelPropertyStatus;
  createdAt: string;
  updatedAt: string;
};

/** Kept in step with sql/014_hostel_foundation.sql; the runtime applies it too. */
const HOSTEL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_landlords (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    organization TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    kyc_status TEXT NOT NULL DEFAULT 'PENDING',
    review_reason TEXT NOT NULL DEFAULT '',
    commission_bps INTEGER NOT NULL DEFAULT 500,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_properties (
    id TEXT PRIMARY KEY,
    landlord_id TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    campus_distance_m INTEGER,
    utilities_enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_rooms (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    label TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 6),
    utilities_fee INTEGER NOT NULL DEFAULT 0,
    amenities TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_spaces (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'AVAILABLE',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_periods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    starts_on TEXT NOT NULL,
    ends_on TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_listings (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    review_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_property_photos (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    r2_key TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_landlords_phone ON hostel_landlords(phone) WHERE phone <> ''",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_landlords_email ON hostel_landlords(email) WHERE email <> ''",
  "CREATE INDEX IF NOT EXISTS idx_hostel_landlords_status ON hostel_landlords(status, kyc_status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_properties_landlord ON hostel_properties(landlord_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_properties_status ON hostel_properties(status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_rooms_property ON hostel_rooms(property_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_spaces_room_status ON hostel_spaces(room_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_periods_active ON hostel_periods(active, starts_on)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_listings_space_period ON hostel_listings(space_id, period_id)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_listings_period_status ON hostel_listings(period_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_photos_property ON hostel_property_photos(property_id, sort_order)",
];

let hostelTablesReady: Promise<void> | null = null;

/** Memoised per isolate; the landlord surfaces must not run DDL per request. */
export function ensureHostelTables() {
  hostelTablesReady ??= (async () => {
    // The landlord joins its console account, so both tables must exist.
    await ensureConsoleAccountsTable();
    await runSchemaPass({
      metaTable: "campus_schema_meta",
      id: "hostelFoundation",
      version: HOSTEL_SCHEMA_VERSION,
      statements: HOSTEL_SCHEMA_STATEMENTS,
    });
  })().catch((error: unknown) => {
    hostelTablesReady = null;
    throw error;
  });
  return hostelTablesReady;
}

function landlordView(row: Record<string, unknown>): HostelLandlord {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    email: String(row.email || ""),
    organization: String(row.organization || ""),
    status: String(row.status || "ACTIVE"),
    kycStatus: String(row.kyc_status || "PENDING") as HostelKycStatus,
    commissionBps: Number(row.commission_bps ?? 500),
    reviewReason: String(row.review_reason || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function propertyView(row: Record<string, unknown>): HostelProperty {
  const latitude = row.latitude === null || row.latitude === undefined ? null : Number(row.latitude);
  const longitude = row.longitude === null || row.longitude === undefined ? null : Number(row.longitude);
  const distance = row.campus_distance_m === null || row.campus_distance_m === undefined ? null : Number(row.campus_distance_m);
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    address: String(row.address || ""),
    latitude: latitude !== null && Number.isFinite(latitude) ? latitude : null,
    longitude: longitude !== null && Number.isFinite(longitude) ? longitude : null,
    campusDistanceM: distance !== null && Number.isFinite(distance) ? distance : null,
    utilitiesEnabled: Number(row.utilities_enabled || 0) === 1,
    status: String(row.status || "DRAFT") as HostelPropertyStatus,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function optionalCoordinate(value: unknown, minimum: number, maximum: number, label: string) {
  if (value === undefined || value === null || value === "") return null;
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < minimum || coordinate > maximum) {
    throw new CampusEngineError("VALIDATION_ERROR", `Enter a ${label} between ${minimum} and ${maximum}, or leave it blank.`, 400);
  }
  return coordinate;
}

/**
 * Open landlord registration (decision D2): the account signs in immediately so
 * the landlord can build the property, and only the listing review can make a
 * bed visible or bookable. No session is required, so the route rate limits the
 * caller before it gets here.
 */
export async function registerLandlord(input: {
  name?: unknown; phone?: unknown; email?: unknown; password?: unknown; organization?: unknown;
}) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Landlord registration is not available on this deployment.", 503);
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
  if (!/^[+0-9][0-9 ()-]{6,19}$/.test(phone)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter a phone number we can reach you on.", 400);
  }
  // Same policy the account will be held to while it is live.
  assertConsolePassword("LANDLORD", password);
  await ensureHostelTables();

  const duplicate = rowsToObjects(await turso(
    "SELECT id FROM hostel_landlords WHERE email = ? OR phone = ? LIMIT 1",
    [email, phone],
  ))[0];
  if (duplicate) {
    throw new CampusEngineError("CONFLICT", "An account already exists for that email address or phone number.", 409);
  }
  const taken = rowsToObjects(await turso("SELECT id FROM console_accounts WHERE email = ? LIMIT 1", [email]))[0];
  if (taken) {
    throw new CampusEngineError("CONFLICT", "That email address is already registered.", 409);
  }

  const stamp = new Date().toISOString();
  const landlordId = crypto.randomUUID();
  await turso(
    "INSERT INTO hostel_landlords (id,name,phone,email,organization,status,kyc_status,commission_bps,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE','PENDING',500,?,?)",
    [landlordId, name, phone, email, organization, stamp, stamp],
  );
  let accountId = "";
  try {
    accountId = await createConsoleAccount({
      email, password, name, phone, role: "LANDLORD", profileId: landlordId, status: "ACTIVE",
    });
  } catch (error) {
    await turso("DELETE FROM hostel_landlords WHERE id = ?", [landlordId]).catch(() => undefined);
    throw error;
  }

  await consoleAudit({
    actor: email,
    action: "LANDLORD_REGISTERED",
    targetType: "hostel_landlord",
    targetReference: landlordId,
    details: { organization },
  }).catch(() => undefined);

  return { landlordId, accountId, status: "ACTIVE" as const };
}

export async function getHostelLandlord(landlordId: string): Promise<HostelLandlord> {
  await ensureHostelTables();
  const row = rowsToObjects(await turso(
    "SELECT id,name,phone,email,COALESCE(organization,'') AS organization,COALESCE(status,'ACTIVE') AS status,COALESCE(kyc_status,'PENDING') AS kyc_status,COALESCE(review_reason,'') AS review_reason,COALESCE(commission_bps,500) AS commission_bps,created_at,updated_at FROM hostel_landlords WHERE id = ? LIMIT 1",
    [landlordId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That landlord account no longer exists.", 404);
  return landlordView(row);
}

export async function listHostelProperties(landlordId: string): Promise<HostelProperty[]> {
  await ensureHostelTables();
  const rows = rowsToObjects(await turso(
    "SELECT id,name,COALESCE(address,'') AS address,latitude,longitude,campus_distance_m,COALESCE(utilities_enabled,0) AS utilities_enabled,COALESCE(status,'DRAFT') AS status,created_at,updated_at FROM hostel_properties WHERE landlord_id = ? ORDER BY created_at DESC",
    [landlordId],
  ));
  return rows.map(propertyView);
}

/** One property, still scoped by its owner: a valid id is not a permission. */
export async function getHostelProperty(landlordId: string, propertyId: string): Promise<HostelProperty> {
  await ensureHostelTables();
  const row = rowsToObjects(await turso(
    "SELECT id,name,COALESCE(address,'') AS address,latitude,longitude,campus_distance_m,COALESCE(utilities_enabled,0) AS utilities_enabled,COALESCE(status,'DRAFT') AS status,created_at,updated_at FROM hostel_properties WHERE id = ? AND landlord_id = ? LIMIT 1",
    [propertyId, landlordId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That property does not belong to your account.", 404);
  return propertyView(row);
}

export async function createHostelProperty(landlordId: string, input: {
  name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown; utilitiesEnabled?: unknown;
}): Promise<HostelProperty> {
  await ensureHostelTables();
  const name = String(input.name || "").trim();
  const address = String(input.address || "").trim();
  if (name.length < 2 || name.length > 80) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give the property a name between 2 and 80 characters.", 400);
  }
  if (address.length < 3 || address.length > 160) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give an address students can find, between 3 and 160 characters.", 400);
  }
  const latitude = optionalCoordinate(input.latitude, -90, 90, "latitude");
  const longitude = optionalCoordinate(input.longitude, -180, 180, "longitude");
  if ((latitude === null) !== (longitude === null)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter both the latitude and the longitude, or neither.", 400);
  }
  const utilitiesEnabled = input.utilitiesEnabled === true || input.utilitiesEnabled === "true" || input.utilitiesEnabled === 1 ? 1 : 0;

  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await turso(
    "INSERT INTO hostel_properties (id,landlord_id,name,address,latitude,longitude,campus_distance_m,utilities_enabled,status,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,'DRAFT',?,?)",
    [id, landlordId, name, address, latitude, longitude, utilitiesEnabled, stamp, stamp],
  );
  await consoleAudit({
    actor: landlordId,
    action: "HOSTEL_PROPERTY_CREATED",
    targetType: "hostel_property",
    targetReference: id,
    details: { name },
  }).catch(() => undefined);
  return getHostelProperty(landlordId, id);
}
