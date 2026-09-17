import { hasColumn, rowsToObjects, turso } from "@/lib/turso";

export type TripDisplayMode = "MORNING" | "EVENING" | "BOTH";
export type TripSchedule = {
  morningDeparture: string;
  morningArrival: string;
  eveningDeparture: string;
  eveningArrival: string;
};
export type FlyerPromo = {
  enabled: boolean;
  title: string;
  route: string;
  fare: string;
  nightBus: string;
  dayBuses: string[];
  dropOffPoints: string[];
  amenities: string[];
  contacts: string[];
};
export type TripSettings = TripSchedule & { mode: TripDisplayMode; flyerPromo: FlyerPromo };

export const DEFAULT_FLYER_PROMO: FlyerPromo = {
  enabled: true,
  title: "UMaT Express",
  route: "UMaT to Accra",
  fare: "GHS 180",
  nightBus: "4th Sept @ 9pm",
  dayBuses: ["5th Sept @ 6am", "7th Sept @ 6am"],
  dropOffPoints: ["Circle", "Kasoa", "Kaneshie", "Mallam"],
  amenities: ["Item 13 assured", "Free Wi-Fi", "Safety & comfort", "Free luggage (limited)"],
  contacts: ["Manuel: 0556179235", "Vision: 0543375583"],
};

export const DEFAULT_TRIP_SETTINGS: TripSettings = {
  mode: "BOTH",
  morningDeparture: "06:30",
  morningArrival: "11:30",
  eveningDeparture: "13:00",
  eveningArrival: "18:00",
  flyerPromo: DEFAULT_FLYER_PROMO,
};

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function ensureTripSettingsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS trip_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    display_mode TEXT NOT NULL DEFAULT 'BOTH',
    morning_departure TEXT NOT NULL DEFAULT '06:30',
    morning_arrival TEXT NOT NULL DEFAULT '11:30',
    evening_departure TEXT NOT NULL DEFAULT '13:00',
    evening_arrival TEXT NOT NULL DEFAULT '18:00',
    flyer_promo TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`);
  const migrations = [
    ["morning_departure", "ALTER TABLE trip_settings ADD COLUMN morning_departure TEXT NOT NULL DEFAULT '06:30'"],
    ["morning_arrival", "ALTER TABLE trip_settings ADD COLUMN morning_arrival TEXT NOT NULL DEFAULT '11:30'"],
    ["evening_departure", "ALTER TABLE trip_settings ADD COLUMN evening_departure TEXT NOT NULL DEFAULT '13:00'"],
    ["evening_arrival", "ALTER TABLE trip_settings ADD COLUMN evening_arrival TEXT NOT NULL DEFAULT '18:00'"],
    ["flyer_promo", "ALTER TABLE trip_settings ADD COLUMN flyer_promo TEXT NOT NULL DEFAULT ''"],
  ] as const;
  for (const [column, sql] of migrations) {
    if (!(await hasColumn("trip_settings", column))) await turso(sql);
  }
  await turso(
    "INSERT OR IGNORE INTO trip_settings (id, display_mode, morning_departure, morning_arrival, evening_departure, evening_arrival, updated_at) VALUES (1, 'BOTH', '06:30', '11:30', '13:00', '18:00', ?)",
    [new Date().toISOString()],
  );
}

export function normalizeFlyerPromo(value: unknown): FlyerPromo {
  const input = typeof value === "object" && value !== null ? value as Partial<FlyerPromo> : {};
  const strings = (items: unknown, fallback: string[]) => Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean)
    : fallback;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_FLYER_PROMO.enabled,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : DEFAULT_FLYER_PROMO.title,
    route: typeof input.route === "string" && input.route.trim() ? input.route.trim() : DEFAULT_FLYER_PROMO.route,
    fare: typeof input.fare === "string" && input.fare.trim() ? input.fare.trim() : DEFAULT_FLYER_PROMO.fare,
    nightBus: typeof input.nightBus === "string" && input.nightBus.trim() ? input.nightBus.trim() : DEFAULT_FLYER_PROMO.nightBus,
    dayBuses: strings(input.dayBuses, DEFAULT_FLYER_PROMO.dayBuses),
    dropOffPoints: strings(input.dropOffPoints, DEFAULT_FLYER_PROMO.dropOffPoints),
    amenities: strings(input.amenities, DEFAULT_FLYER_PROMO.amenities),
    contacts: strings(input.contacts, DEFAULT_FLYER_PROMO.contacts),
  };
}

function parseFlyerPromo(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_FLYER_PROMO;
  try {
    const promo = normalizeFlyerPromo(JSON.parse(value));
    return promo.fare === "GHS 190" || promo.fare === "GH₵ 190" || promo.fare === "GH₵190" ? { ...promo, fare: DEFAULT_FLYER_PROMO.fare } : promo;
  } catch {
    return DEFAULT_FLYER_PROMO;
  }
}

export async function getTripSettings(): Promise<TripSettings> {
  await ensureTripSettingsTable();
  const row = rowsToObjects(await turso("SELECT display_mode, morning_departure, morning_arrival, evening_departure, evening_arrival, flyer_promo FROM trip_settings WHERE id = 1"))[0];
  const rawMode = String(row?.display_mode || DEFAULT_TRIP_SETTINGS.mode);
  return {
    mode: rawMode === "MORNING" || rawMode === "EVENING" ? rawMode : "BOTH",
    morningDeparture: String(row?.morning_departure || DEFAULT_TRIP_SETTINGS.morningDeparture),
    morningArrival: String(row?.morning_arrival || DEFAULT_TRIP_SETTINGS.morningArrival),
    eveningDeparture: String(row?.evening_departure || DEFAULT_TRIP_SETTINGS.eveningDeparture),
    eveningArrival: String(row?.evening_arrival || DEFAULT_TRIP_SETTINGS.eveningArrival),
    flyerPromo: parseFlyerPromo(row?.flyer_promo),
  };
}

export async function getTripDisplayMode() {
  return (await getTripSettings()).mode;
}

export function activeTripIds(mode: TripDisplayMode) {
  if (mode === "MORNING") return [1];
  if (mode === "EVENING") return [2];
  return [1, 2];
}

export function tripIsEnabled(mode: TripDisplayMode, tripId: number) {
  return activeTripIds(mode).includes(tripId);
}

export function departureForTrip(settings: TripSettings, tripId: number) {
  return tripId === 2 ? settings.eveningDeparture : settings.morningDeparture;
}
