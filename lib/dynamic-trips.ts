import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
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

export async function ensureScheduledTripsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS scheduled_trips (
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
  )`);

  const columns = rowsToObjects(await turso("PRAGMA table_info(scheduled_trips)")).map((row) => String(row.name));
  const migrations: Array<[string, string]> = [
    ["travel_date", "ALTER TABLE scheduled_trips ADD COLUMN travel_date TEXT NOT NULL DEFAULT '2026-09-05'"],
    ["tag", "ALTER TABLE scheduled_trips ADD COLUMN tag TEXT NOT NULL DEFAULT ''"],
    ["amenities", "ALTER TABLE scheduled_trips ADD COLUMN amenities TEXT NOT NULL DEFAULT '[\"AC\",\"Wi-Fi\",\"USB power\"]'"],
    ["archived", "ALTER TABLE scheduled_trips ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"],
    ["display_order", "ALTER TABLE scheduled_trips ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "ALTER TABLE scheduled_trips ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, sql] of migrations) {
    if (!columns.includes(column)) await turso(sql);
  }
}

export async function seedDefaultScheduledTrips() {
  if (!(await isTursoConfiguredRuntime())) return;
  await ensureScheduledTripsTable();
  const now = new Date().toISOString();
  for (const trip of legacyTrips) {
    await turso(
      "INSERT OR IGNORE INTO scheduled_trips (id, title, route_from, route_to, travel_date, departure_time, arrival_time, price, capacity, coach_type, tag, amenities, notes, active, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      [
        String(trip.id),
        trip.tag,
        trip.from,
        trip.to,
        TRAVEL_DATE,
        trip.id === 2 ? "13:00" : "06:30",
        trip.id === 2 ? "18:00" : "11:30",
        trip.price,
        50,
        "VIP Coach",
        trip.tag,
        JSON.stringify(DEFAULT_AMENITIES),
        "",
        trip.id,
        now,
        now,
      ],
    );
    await turso("UPDATE scheduled_trips SET price = ?, updated_at = ? WHERE id = ?", [trip.price, now, String(trip.id)]);
  }
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
  };
}

export async function getDynamicTrips({ activeOnly = true, includeArchived = false } = {}) {
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
    `SELECT id, title, route_from, route_to, travel_date, departure_time, arrival_time, price, capacity, coach_type, tag, amenities, notes, active, archived, display_order, created_at
     FROM scheduled_trips WHERE ${includeArchived ? "1 = 1" : "archived = 0"} ${activeOnly ? "AND active = 1" : ""}
     ORDER BY display_order ASC, travel_date ASC, departure_time ASC, created_at DESC`,
  ));
  return rows.map(normalizeTrip);
}

export async function getDynamicTrip(id: string, options: { includeArchived?: boolean } = {}) {
  const trips = await getDynamicTrips({ activeOnly: false, includeArchived: options.includeArchived });
  return trips.find((trip) => trip.id === id);
}
