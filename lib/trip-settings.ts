import { hasColumn, rowsToObjects, turso } from "@/lib/turso";
import { hasNoticeContent, normalizeFlyerPromo, type FlyerPromo } from "@/lib/trip-notice";

export { normalizeFlyerPromo };
export type { FlyerPromo };

export type TripDisplayMode = "MORNING" | "EVENING" | "BOTH";
export type TripSchedule = {
  morningDeparture: string;
  morningArrival: string;
  eveningDeparture: string;
  eveningArrival: string;
};
export type TripSettings = TripSchedule & { mode: TripDisplayMode; flyerPromo: FlyerPromo };

function envText(name: string) {
  if (typeof process === "undefined") return "";
  return String(process.env?.[name] ?? "").trim();
}

function envList(name: string) {
  return envText(name).split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Fallback notice for a deployment that has not saved anything yet. Read from
 * configuration so no fare, contact number or departure time is baked into the
 * source, and left disabled when nothing is configured.
 */
export function flyerPromoFromEnv(): FlyerPromo {
  const promo: FlyerPromo = {
    enabled: true,
    title: envText("TRIP_NOTICE_TITLE"),
    route: envText("TRIP_NOTICE_ROUTE"),
    fare: envText("TRIP_NOTICE_FARE"),
    nightBus: envText("TRIP_NOTICE_NIGHT_BUS"),
    dayBuses: envList("TRIP_NOTICE_DAY_BUSES"),
    dropOffPoints: envList("TRIP_NOTICE_DROP_OFFS"),
    amenities: envList("TRIP_NOTICE_AMENITIES"),
    contacts: envList("TRIP_NOTICE_CONTACTS"),
  };
  return { ...promo, enabled: hasNoticeContent(promo) };
}

export const DEFAULT_FLYER_PROMO: FlyerPromo = flyerPromoFromEnv();

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
