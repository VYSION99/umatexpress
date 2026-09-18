import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";
import { TRAVEL_DATE, trips as legacyTrips } from "@/lib/trips";

export type DynamicTrip = {
  id: string;
  title: string;
  from: string;
  to: string;
  travelDate: string;
  time: string;
  arrival: string;
  price: number;
  capacity: number;
  coachType: string;
  tag: string;
  amenities: string[];
  notes: string;
  active: boolean;
  archived: boolean;
  displayOrder: number;
  createdAt: string;
  /** Empty means the platform owns the trip; see `trip_organizers`. */
  organizerId: string;
  /** DRAFT | PENDING_REVIEW | APPROVED | REJECTED | SUSPENDED */
  reviewStatus: string;
};

const DEFAULT_AMENITIES = ["AC", "Wi-Fi", "USB power"];

function parseList(value: unknown, fallback = DEFAULT_AMENITIES) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
}

const TRIPS_SCHEMA_VERSION = "2026-09-18.1";

function sqlText(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The legacy seed lives in the schema pass rather than on the read path. It
 * used to run on every public read, which cost four subrequests, resurrected a
 * trip an admin had deleted, and overwrote the price they had edited.
 */
const tripsSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS scheduled_trips (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    route_from TEXT NOT NULL,
    route_to TEXT NOT NULL,
    travel_date TEXT NOT NULL DEFAULT '2026-09-05',
    departure_time TEXT NOT NULL,
    arrival_time TEXT NOT NULL,
    price INTEGER NOT NULL,
    capacity INTEGER NOT NULL,
    coach_type TEXT NOT NULL DEFAULT 'VIP Coach',
    tag TEXT NOT NULL DEFAULT '',
    amenities TEXT NOT NULL DEFAULT '["AC","Wi-Fi","USB power"]',
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    organizer_id TEXT,
    review_status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
  )`,
  "ALTER TABLE scheduled_trips ADD COLUMN travel_date TEXT NOT NULL DEFAULT '2026-09-05'",
  "ALTER TABLE scheduled_trips ADD COLUMN tag TEXT NOT NULL DEFAULT ''",
  `ALTER TABLE scheduled_trips ADD COLUMN amenities TEXT NOT NULL DEFAULT '["AC","Wi-Fi","USB power"]'`,
  "ALTER TABLE scheduled_trips ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE scheduled_trips ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE scheduled_trips ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE scheduled_trips ADD COLUMN organizer_id TEXT",
  "ALTER TABLE scheduled_trips ADD COLUMN review_status TEXT NOT NULL DEFAULT 'DRAFT'",
  // Every trip that existed before review existed has no owner and is already
  // live, so it belongs to the platform and is approved. Anything created
  // afterwards defaults to DRAFT and must be reviewed.
  "UPDATE scheduled_trips SET review_status = 'APPROVED' WHERE organizer_id IS NULL AND review_status = 'DRAFT'",
  "CREATE INDEX IF NOT EXISTS idx_scheduled_trips_organizer ON scheduled_trips(organizer_id)",
  "CREATE INDEX IF NOT EXISTS idx_scheduled_trips_review ON scheduled_trips(review_status, active, archived)",
  ...legacyTrips.map((trip) => `INSERT OR IGNORE INTO scheduled_trips (id, title, route_from, route_to, travel_date, departure_time, arrival_time, price, capacity, coach_type, tag, amenities, notes, active, display_order, organizer_id, review_status, created_at, updated_at) VALUES (${sqlText(String(trip.id))}, ${sqlText(trip.tag)}, ${sqlText(trip.from)}, ${sqlText(trip.to)}, ${sqlText(TRAVEL_DATE)}, ${sqlText(trip.id === 2 ? "13:00" : "06:30")}, ${sqlText(trip.id === 2 ? "18:00" : "11:30")}, ${trip.price}, 50, 'VIP Coach', ${sqlText(trip.tag)}, ${sqlText(JSON.stringify(DEFAULT_AMENITIES))}, '', 1, ${trip.id}, NULL, 'APPROVED', '${new Date().toISOString()}', '${new Date().toISOString()}')`),
];

let tripsTableReady: Promise<void> | null = null;

export function ensureScheduledTripsTable() {
  tripsTableReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "scheduledTrips",
    version: TRIPS_SCHEMA_VERSION,
    statements: tripsSchemaStatements,
  }).catch((error: unknown) => {
    tripsTableReady = null;
    throw error;
  });
  return tripsTableReady;
}

export async function seedDefaultScheduledTrips() {
  await ensureScheduledTripsTable();
}

function normalizeTrip(row: Record<string, unknown>): DynamicTrip {
  const id = String(row.id || "");
  const title = String(row.title || "");
  return {
    id,
    title,
    from: String(row.route_from || ""),
    to: String(row.route_to || ""),
    travelDate: String(row.travel_date || TRAVEL_DATE),
    time: String(row.departure_time || ""),
    arrival: String(row.arrival_time || ""),
    price: Number(row.price || 0),
    capacity: Number(row.capacity || 50),
    coachType: String(row.coach_type || "VIP Coach"),
    tag: String(row.tag || title || "Express"),
    amenities: parseList(row.amenities),
    notes: String(row.notes || ""),
    active: Number(row.active ?? 1) === 1,
    archived: Number(row.archived ?? 0) === 1,
    displayOrder: Number(row.display_order || 0),
    createdAt: String(row.created_at || new Date().toISOString()),
    organizerId: String(row.organizer_id || ""),
    // Fails safe: a row whose review status is missing is treated as unseen by
    // students rather than as approved.
    reviewStatus: String(row.review_status || "DRAFT"),
  };
}

export async function getDynamicTrips({ activeOnly = true, includeArchived = false, approvedOnly = true } = {}) {
  if (!(await isTursoConfiguredRuntime())) {
    return legacyTrips.map((trip) => ({
      id: String(trip.id),
      title: trip.tag,
      from: trip.from,
      to: trip.to,
      travelDate: TRAVEL_DATE,
      time: trip.id === 2 ? "13:00" : "06:30",
      arrival: trip.id === 2 ? "18:00" : "11:30",
      price: trip.price,
      capacity: 50,
      coachType: "VIP Coach",
      tag: trip.tag,
      amenities: DEFAULT_AMENITIES,
      notes: "",
      active: true,
      archived: false,
      displayOrder: trip.id,
      createdAt: new Date().toISOString(),
    }));
  }

  await seedDefaultScheduledTrips();
  const rows = rowsToObjects(await turso(
    `SELECT id, title, route_from, route_to, travel_date, departure_time, arrival_time, price, capacity, coach_type, tag, amenities, notes, active, archived, display_order, created_at, COALESCE(organizer_id,'') AS organizer_id, COALESCE(review_status,'DRAFT') AS review_status
     FROM scheduled_trips WHERE ${includeArchived ? "1 = 1" : "archived = 0"} ${activeOnly ? "AND active = 1" : ""} ${approvedOnly ? "AND review_status = 'APPROVED'" : ""}
     ORDER BY display_order ASC, travel_date ASC, departure_time ASC, created_at DESC`,
  ));
  return rows.map(normalizeTrip);
}

export async function getDynamicTrip(id: string, options: { includeArchived?: boolean; approvedOnly?: boolean } = {}) {
  const trips = await getDynamicTrips({ activeOnly: false, includeArchived: options.includeArchived, approvedOnly: options.approvedOnly });
  return trips.find((trip) => trip.id === id);
}
