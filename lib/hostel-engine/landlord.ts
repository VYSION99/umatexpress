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

export const HOSTEL_SCHEMA_VERSION = "2026-09-20.3";

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
    submitted_at TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "ALTER TABLE hostel_listings ADD COLUMN submitted_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_listings ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_listings ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT ''",
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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_rooms_property_label ON hostel_rooms(property_id, label) WHERE status = 'ACTIVE'",
  "CREATE INDEX IF NOT EXISTS idx_hostel_spaces_room_status ON hostel_spaces(room_id, status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_spaces_room_label ON hostel_spaces(room_id, label) WHERE status <> 'RETIRED'",
  "CREATE INDEX IF NOT EXISTS idx_hostel_periods_active ON hostel_periods(active, starts_on)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_listings_space_period ON hostel_listings(space_id, period_id)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_listings_period_status ON hostel_listings(period_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_listings_status_submitted ON hostel_listings(status, submitted_at)",
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

// ---------------------------------------------------------------------------
// Rooms and bed-spaces
// ---------------------------------------------------------------------------

/** The landlord id for a signed-in console account, or a refusal. */
export function landlordIdFromAccount(account: { profileId?: string }) {
  if (!account.profileId) {
    throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to a landlord profile.", 401);
  }
  return account.profileId;
}

export const HOSTEL_ROOM_STATUSES = ["ACTIVE", "RETIRED"] as const;
export type HostelRoomStatus = (typeof HOSTEL_ROOM_STATUSES)[number];

export const HOSTEL_SPACE_STATUSES = ["AVAILABLE", "RETIRED"] as const;
export type HostelSpaceStatus = (typeof HOSTEL_SPACE_STATUSES)[number];

export type HostelRoom = {
  id: string;
  propertyId: string;
  label: string;
  capacity: number;
  utilitiesFee: number;
  amenities: string;
  status: HostelRoomStatus;
  createdAt: string;
  updatedAt: string;
};

export type HostelSpace = {
  id: string;
  roomId: string;
  label: string;
  status: HostelSpaceStatus;
  createdAt: string;
  updatedAt: string;
};

export type HostelRoomWithSpaces = HostelRoom & { spaces: HostelSpace[] };
export type HostelPropertyDetail = { property: HostelProperty; rooms: HostelRoomWithSpaces[] };

/** Every bed a room may hold, in the order landlords name them. */
const BED_NAMES = ["Bed A", "Bed B", "Bed C", "Bed D", "Bed E", "Bed F"];

const ROOM_COLUMNS = "id,property_id,label,capacity,COALESCE(utilities_fee,0) AS utilities_fee,COALESCE(amenities,'') AS amenities,COALESCE(status,'ACTIVE') AS status,created_at,updated_at";
const SPACE_COLUMNS = "s.id,s.room_id,s.label,COALESCE(s.status,'AVAILABLE') AS status,s.created_at,s.updated_at";
/** Ten thousand cedis per bed is far past any real utilities fee. */
const MAX_UTILITIES_FEE = 1_000_000;

function roomView(row: Record<string, unknown>): HostelRoom {
  return {
    id: String(row.id || ""),
    propertyId: String(row.property_id || ""),
    label: String(row.label || ""),
    capacity: Number(row.capacity ?? 0),
    utilitiesFee: Number(row.utilities_fee ?? 0),
    amenities: String(row.amenities || ""),
    status: String(row.status || "ACTIVE") as HostelRoomStatus,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function spaceView(row: Record<string, unknown>): HostelSpace {
  return {
    id: String(row.id || ""),
    roomId: String(row.room_id || ""),
    label: String(row.label || ""),
    status: String(row.status || "AVAILABLE") as HostelSpaceStatus,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function requiredText(value: unknown, minimum: number, maximum: number, message: string) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) throw new CampusEngineError("VALIDATION_ERROR", message, 400);
  return text;
}

function integerInRange(value: unknown, minimum: number, maximum: number, message: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new CampusEngineError("VALIDATION_ERROR", message, 400);
  }
  return number;
}

function optedText(value: unknown, maximum: number, message: string) {
  const text = String(value ?? "").trim();
  if (text.length > maximum) throw new CampusEngineError("VALIDATION_ERROR", message, 400);
  return text;
}

/**
 * The beds a listing already points at. Phase 2 creates listings, but the
 * capacity and retirement rules have to know about them from the day the table
 * exists: a room cannot shrink or retire out from under an offer.
 */
async function listedSpaceIds(roomId: string): Promise<Set<string>> {
  const rows = rowsToObjects(await turso(
    "SELECT DISTINCT l.space_id AS space_id FROM hostel_listings l JOIN hostel_spaces s ON s.id = l.space_id WHERE s.room_id = ? AND l.status IN ('DRAFT','PENDING_REVIEW','APPROVED')",
    [roomId],
  ));
  return new Set(rows.map((row) => String(row.space_id || "")));
}

export async function updateHostelProperty(landlordId: string, propertyId: string, input: {
  name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown; utilitiesEnabled?: unknown;
}): Promise<HostelProperty> {
  await ensureHostelTables();
  // Ownership first: a valid property id is not a permission.
  await getHostelProperty(landlordId, propertyId);
  const name = requiredText(input.name, 2, 80, "Give the property a name between 2 and 80 characters.");
  const address = requiredText(input.address, 3, 160, "Give an address students can find, between 3 and 160 characters.");
  const latitude = optionalCoordinate(input.latitude, -90, 90, "latitude");
  const longitude = optionalCoordinate(input.longitude, -180, 180, "longitude");
  if ((latitude === null) !== (longitude === null)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter both the latitude and the longitude, or neither.", 400);
  }
  const utilitiesEnabled = input.utilitiesEnabled === true || input.utilitiesEnabled === "true" || input.utilitiesEnabled === 1 ? 1 : 0;
  await turso(
    "UPDATE hostel_properties SET name=?,address=?,latitude=?,longitude=?,utilities_enabled=?,updated_at=? WHERE id=? AND landlord_id=?",
    [name, address, latitude, longitude, utilitiesEnabled, new Date().toISOString(), propertyId, landlordId],
  );
  await consoleAudit({
    actor: landlordId, action: "HOSTEL_PROPERTY_UPDATED", targetType: "hostel_property", targetReference: propertyId, details: { name },
  }).catch(() => undefined);
  return getHostelProperty(landlordId, propertyId);
}

export async function getHostelPropertyDetail(landlordId: string, propertyId: string): Promise<HostelPropertyDetail> {
  const property = await getHostelProperty(landlordId, propertyId);
  const rooms = rowsToObjects(await turso(
    `SELECT ${ROOM_COLUMNS} FROM hostel_rooms WHERE property_id = ? ORDER BY label COLLATE NOCASE ASC`,
    [propertyId],
  )).map(roomView);
  const spaces = rowsToObjects(await turso(
    `SELECT ${SPACE_COLUMNS} FROM hostel_spaces s JOIN hostel_rooms r ON r.id = s.room_id WHERE r.property_id = ? ORDER BY s.label COLLATE NOCASE ASC`,
    [propertyId],
  )).map(spaceView);
  return {
    property,
    rooms: rooms.map((room) => ({ ...room, spaces: spaces.filter((space) => space.roomId === room.id) })),
  };
}

/** One room, scoped through its property to the signed-in landlord. */
export async function getHostelRoom(landlordId: string, roomId: string): Promise<HostelRoom> {
  await ensureHostelTables();
  const row = rowsToObjects(await turso(
    `SELECT r.id,r.property_id,r.label,r.capacity,COALESCE(r.utilities_fee,0) AS utilities_fee,COALESCE(r.amenities,'') AS amenities,COALESCE(r.status,'ACTIVE') AS status,r.created_at,r.updated_at
     FROM hostel_rooms r JOIN hostel_properties p ON p.id = r.property_id WHERE r.id = ? AND p.landlord_id = ? LIMIT 1`,
    [roomId, landlordId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That room does not belong to your account.", 404);
  return roomView(row);
}

async function roomSpaces(roomId: string): Promise<HostelSpace[]> {
  const rows = rowsToObjects(await turso(
    `SELECT s.id,s.room_id,s.label,COALESCE(s.status,'AVAILABLE') AS status,s.created_at,s.updated_at FROM hostel_spaces s WHERE s.room_id = ? ORDER BY s.label COLLATE NOCASE ASC`,
    [roomId],
  ));
  return rows.map(spaceView);
}

async function createBeds(roomId: string, labels: string[], stamp: string) {
  for (const label of labels) {
    await turso(
      "INSERT INTO hostel_spaces (id,room_id,label,status,created_at,updated_at) VALUES (?,?,?,'AVAILABLE',?,?)",
      [crypto.randomUUID(), roomId, label, stamp, stamp],
    );
  }
}

function unusedBedNames(used: string[], count: number) {
  const taken = new Set(used);
  const labels: string[] = [];
  for (const name of BED_NAMES) {
    if (labels.length >= count) break;
    if (!taken.has(name)) { labels.push(name); taken.add(name); }
  }
  return labels;
}

export async function createHostelRoom(landlordId: string, propertyId: string, input: {
  label?: unknown; capacity?: unknown; utilitiesFee?: unknown; amenities?: unknown;
}): Promise<HostelRoomWithSpaces> {
  await ensureHostelTables();
  // Ownership first: the property must belong to the caller.
  await getHostelProperty(landlordId, propertyId);
  const label = requiredText(input.label, 1, 24, "Give the room a name like \"Room 3\" (1 to 24 characters).");
  const capacity = integerInRange(input.capacity, 1, 6, "A room holds between 1 and 6 beds.");
  const utilitiesFee = input.utilitiesFee === undefined || input.utilitiesFee === null || input.utilitiesFee === ""
    ? 0
    : integerInRange(input.utilitiesFee, 0, MAX_UTILITIES_FEE, "Enter the utilities fee per bed in pesewas, or leave it at 0.");
  const amenities = optedText(input.amenities, 200, "Keep the amenities line under 200 characters.");

  const duplicate = rowsToObjects(await turso(
    "SELECT id FROM hostel_rooms WHERE property_id = ? AND label = ? AND status = 'ACTIVE' LIMIT 1",
    [propertyId, label],
  ))[0];
  if (duplicate) throw new CampusEngineError("CONFLICT", "Another active room on this property already has that name.", 409);

  const stamp = new Date().toISOString();
  const roomId = crypto.randomUUID();
  await turso(
    "INSERT INTO hostel_rooms (id,property_id,label,capacity,utilities_fee,amenities,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'ACTIVE',?,?)",
    [roomId, propertyId, label, capacity, utilitiesFee, amenities, stamp, stamp],
  );
  await createBeds(roomId, unusedBedNames([], capacity), stamp);
  await consoleAudit({
    actor: landlordId, action: "HOSTEL_ROOM_CREATED", targetType: "hostel_room", targetReference: roomId, details: { propertyId, label, capacity },
  }).catch(() => undefined);
  return { ...(await getHostelRoom(landlordId, roomId)), spaces: await roomSpaces(roomId) };
}

/**
 * Edits a room and keeps its beds in step with `capacity`: growing adds beds,
 * shrinking retires the highest-lettered free ones, and a bed a listing points
 * at is never retired silently.
 */
export async function updateHostelRoom(landlordId: string, roomId: string, input: {
  label?: unknown; capacity?: unknown; utilitiesFee?: unknown; amenities?: unknown; status?: unknown;
}): Promise<HostelRoomWithSpaces> {
  const room = await getHostelRoom(landlordId, roomId);
  const label = input.label === undefined ? room.label : requiredText(input.label, 1, 24, "Give the room a name like \"Room 3\" (1 to 24 characters).");
  const capacity = input.capacity === undefined ? room.capacity : integerInRange(input.capacity, 1, 6, "A room holds between 1 and 6 beds.");
  const utilitiesFee = input.utilitiesFee === undefined ? room.utilitiesFee : integerInRange(input.utilitiesFee, 0, MAX_UTILITIES_FEE, "Enter the utilities fee per bed in pesewas, or leave it at 0.");
  const amenities = input.amenities === undefined ? room.amenities : optedText(input.amenities, 200, "Keep the amenities line under 200 characters.");
  let status: HostelRoomStatus = room.status;
  if (input.status !== undefined) {
    if (!(HOSTEL_ROOM_STATUSES as readonly string[]).includes(String(input.status))) {
      throw new CampusEngineError("VALIDATION_ERROR", "A room is either ACTIVE or RETIRED.", 400);
    }
    status = String(input.status) as HostelRoomStatus;
  }

  if (label !== room.label) {
    const duplicate = rowsToObjects(await turso(
      "SELECT id FROM hostel_rooms WHERE property_id = ? AND label = ? AND status = 'ACTIVE' AND id <> ? LIMIT 1",
      [room.propertyId, label, roomId],
    ))[0];
    if (duplicate) throw new CampusEngineError("CONFLICT", "Another active room on this property already has that name.", 409);
  }

  const stamp = new Date().toISOString();
  const allSpaces = await roomSpaces(roomId);
  const active = allSpaces.filter((space) => space.status !== "RETIRED");
  if (capacity < active.length) {
    const surplus = active.slice().sort((left, right) => right.label.localeCompare(left.label, undefined, { numeric: true })).slice(0, active.length - capacity);
    const listed = await listedSpaceIds(roomId);
    const blocked = surplus.filter((space) => listed.has(space.id));
    if (blocked.length) {
      throw new CampusEngineError("INVALID_STATE", `Those beds have listings: ${blocked.map((space) => space.label).join(", ")}. Cancel the listing before shrinking the room.`, 409);
    }
    for (const space of surplus) {
      await turso("UPDATE hostel_spaces SET status='RETIRED',updated_at=? WHERE id=?", [stamp, space.id]);
    }
  } else if (capacity > active.length) {
    // Beds are restored before new ones are minted: a room that shrank and grew
    // back must not end up with a retired "Bed C" sitting beside a live one.
    const retired = allSpaces
      .filter((space) => space.status === "RETIRED")
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }))
      .slice(0, capacity - active.length);
    for (const space of retired) {
      await turso("UPDATE hostel_spaces SET status='AVAILABLE',updated_at=? WHERE id=?", [stamp, space.id]);
    }
    const added = capacity - active.length - retired.length;
    if (added > 0) await createBeds(roomId, unusedBedNames([...active, ...retired].map((space) => space.label), added), stamp);
  }

  if (status === "RETIRED" && room.status !== "RETIRED") {
    const listed = await listedSpaceIds(roomId);
    if (listed.size) {
      throw new CampusEngineError("INVALID_STATE", "This room has listings. Cancel them before retiring it.", 409);
    }
    await turso("UPDATE hostel_spaces SET status='RETIRED',updated_at=? WHERE room_id=? AND status<>'RETIRED'", [stamp, roomId]);
  }

  await turso(
    "UPDATE hostel_rooms SET label=?,capacity=?,utilities_fee=?,amenities=?,status=?,updated_at=? WHERE id=? AND property_id=?",
    [label, capacity, utilitiesFee, amenities, status, stamp, roomId, room.propertyId],
  );
  await consoleAudit({
    actor: landlordId, action: "HOSTEL_ROOM_UPDATED", targetType: "hostel_room", targetReference: roomId, details: { label, capacity, status },
  }).catch(() => undefined);
  return { ...(await getHostelRoom(landlordId, roomId)), spaces: await roomSpaces(roomId) };
}

/** Renames or retires one bed; the room's capacity stays the landlord's call. */
export async function updateHostelSpace(landlordId: string, spaceId: string, input: {
  label?: unknown; status?: unknown;
}): Promise<HostelSpace> {
  await ensureHostelTables();
  const row = rowsToObjects(await turso(
    `SELECT ${SPACE_COLUMNS} FROM hostel_spaces s JOIN hostel_rooms r ON r.id = s.room_id JOIN hostel_properties p ON p.id = r.property_id WHERE s.id = ? AND p.landlord_id = ? LIMIT 1`,
    [spaceId, landlordId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That bed does not belong to your account.", 404);
  const space = spaceView(row);
  const label = input.label === undefined ? space.label : requiredText(input.label, 1, 24, "Give the bed a name (1 to 24 characters).");
  let status: HostelSpaceStatus = space.status;
  if (input.status !== undefined) {
    if (!(HOSTEL_SPACE_STATUSES as readonly string[]).includes(String(input.status))) {
      throw new CampusEngineError("VALIDATION_ERROR", "A bed is either AVAILABLE or RETIRED.", 400);
    }
    status = String(input.status) as HostelSpaceStatus;
  }
  if (label !== space.label) {
    const duplicate = rowsToObjects(await turso(
      "SELECT id FROM hostel_spaces WHERE room_id = ? AND label = ? AND status <> 'RETIRED' AND id <> ? LIMIT 1",
      [space.roomId, label, spaceId],
    ))[0];
    if (duplicate) throw new CampusEngineError("CONFLICT", "Another bed in this room already has that name.", 409);
  }
  await turso("UPDATE hostel_spaces SET label=?,status=?,updated_at=? WHERE id=?", [label, status, new Date().toISOString(), spaceId]);
  await consoleAudit({
    actor: landlordId, action: "HOSTEL_SPACE_UPDATED", targetType: "hostel_space", targetReference: spaceId, details: { label, status },
  }).catch(() => undefined);
  return { ...space, label, status };
}
