import { CampusEngineError } from "@/lib/campus-engine/errors";
import { CAMPUS_NOTIFY_SUBJECTS, campusSeatWatchNotice } from "@/lib/campus-engine/notify-templates";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * "Tell me when a seat opens."
 *
 * A departure board is only useful while somebody is running the route. The
 * quiet half of the day is exactly when a student walks to a gate, sees nothing
 * live, and goes back to their room — and the platform never learns they wanted
 * a ride. A watch records that want against one corridor and settles it later,
 * so a student who looked at the board at the wrong moment is still the first
 * person told when a driver opens the route.
 *
 * It is deliberately not a subscription to everything: one row per corridor per
 * email, settled once, and re-armed only when the student asks again.
 */

export const SEAT_WATCH_SCHEMA_VERSION = "2026-09-24.1";

const CAMPUS_SEAT_WATCH_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS campus_seat_watch (
    id TEXT PRIMARY KEY,
    corridor_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'board',
    active INTEGER NOT NULL DEFAULT 1,
    notified_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // One watch per person per route: asking twice is a change of mind, not a
  // second row, and the database is what makes that true under two taps.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_seat_watch ON campus_seat_watch(corridor_id, email)",
  "CREATE INDEX IF NOT EXISTS idx_campus_seat_watch_open ON campus_seat_watch(active, notified_at)",
];

let watchTablesReady: Promise<void> | null = null;

export function ensureCampusSeatWatchTables() {
  watchTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "campusSeatWatch",
    version: SEAT_WATCH_SCHEMA_VERSION,
    statements: CAMPUS_SEAT_WATCH_STATEMENTS,
  }).catch((error: unknown) => {
    watchTablesReady = null;
    throw error;
  });
  return watchTablesReady;
}

export type CampusSeatWatch = {
  id: string;
  corridorId: string;
  email: string;
  name: string;
  phone: string;
  source: string;
  active: boolean;
  notifiedAt: string;
  createdAt: string;
  updatedAt: string;
};

function watchView(row: Record<string, unknown>): CampusSeatWatch {
  return {
    id: String(row.id),
    corridorId: String(row.corridor_id || ""),
    email: String(row.email || ""),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    source: String(row.source || "board"),
    active: Number(row.active) === 1,
    notifiedAt: String(row.notified_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

/** Kept deliberately plain: an address that cannot receive mail is not a watch. */
function normalizeWatchEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) throw new CampusEngineError("VALIDATION_ERROR", "Add the email address we should write to.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw new CampusEngineError("VALIDATION_ERROR", "That email address does not look usable.", 400);
  }
  return email;
}

export async function watchCampusCorridor(input: { corridorId?: unknown; email?: unknown; name?: unknown; phone?: unknown; source?: unknown }) {
  const corridorId = String(input.corridorId || "").trim();
  if (!corridorId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the route you want to hear about.", 400);
  if (!(await isTursoConfiguredRuntime())) {
    // Preview mode still tells the caller what it would have recorded.
    return { corridorId, email: String(input.email || "").trim().toLowerCase(), active: true, notifiedAt: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), preview: true } as CampusSeatWatch & { preview: true };
  }
  await ensureCampusSeatWatchTables();
  const email = normalizeWatchEmail(input.email);
  const stamp = new Date().toISOString();
  // Asking again re-arms the watch: `notified_at` is cleared so the next open
  // seat is announced, and the stored details are refreshed from the account.
  await turso(
    `INSERT INTO campus_seat_watch (id,corridor_id,email,name,phone,source,active,notified_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,1,'',?,?)
     ON CONFLICT(corridor_id, email) DO UPDATE SET
       name = excluded.name, phone = excluded.phone, source = excluded.source,
       active = 1, notified_at = '', updated_at = excluded.updated_at`,
    [crypto.randomUUID(), corridorId, email, String(input.name || "").trim().slice(0, 120), String(input.phone || "").trim().slice(0, 30), String(input.source || "board").slice(0, 40), stamp, stamp],
  );
  await incrementMetric("campus_watch_created");
  const row = rowsToObjects(await turso("SELECT * FROM campus_seat_watch WHERE corridor_id = ? AND email = ? LIMIT 1", [corridorId, email]))[0];
  return watchView(row);
}

export async function findCampusSeatWatch(corridorId: string, email: string) {
  if (!(await isTursoConfiguredRuntime())) return null;
  await ensureCampusSeatWatchTables();
  const row = rowsToObjects(await turso("SELECT * FROM campus_seat_watch WHERE corridor_id = ? AND email = ? LIMIT 1", [String(corridorId || ""), String(email || "").trim().toLowerCase()]))[0];
  return row ? watchView(row) : null;
}

export async function listCampusSeatWatches(options: { corridorId?: string; limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return [] as CampusSeatWatch[];
  await ensureCampusSeatWatchTables();
  const limit = Math.max(1, Math.min(200, Math.round(options.limit || 50)));
  const rows = options.corridorId
    ? await turso("SELECT * FROM campus_seat_watch WHERE corridor_id = ? ORDER BY created_at DESC LIMIT ?", [String(options.corridorId), limit])
    : await turso("SELECT * FROM campus_seat_watch ORDER BY created_at DESC LIMIT ?", [limit]);
  return rowsToObjects(rows).map(watchView);
}

/** A route's seat count, as the board and the sweep both need to read it. */
export function openSeatsByCorridor(rides: Array<{ corridorId: string; status: string; acceptingQueue: boolean; availableSlots: number }>) {
  const open = new Map<string, number>();
  for (const ride of rides) {
    if (String(ride.status).toUpperCase() !== "OPEN") continue;
    if (!ride.acceptingQueue) continue;
    const seats = Math.max(0, Math.round(Number(ride.availableSlots) || 0));
    if (seats <= 0) continue;
    open.set(ride.corridorId, (open.get(ride.corridorId) || 0) + seats);
  }
  return open;
}

/**
 * Settles the promises. Every five minutes: which watched routes have a seat
 * open right now, and who has not been told yet. A watch is settled once — the
 * row keeps the time — so a route that stays open does not become a daily mail.
 */
export async function runCampusSeatWatchSweep(options: { limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { configured: false, considered: 0, notified: 0 };
  await ensureCampusSeatWatchTables();
  const limit = Math.max(1, Math.min(200, Math.round(options.limit || 100)));
  const rows = rowsToObjects(await turso(
    `SELECT w.id AS watch_id, w.corridor_id, w.email, w.name,
        COALESCE(c.name,'') AS corridor_name,
        COALESCE((
          SELECT SUM(r.available_slots) FROM campus_rides r
          WHERE r.corridor_id = w.corridor_id AND r.status = 'OPEN' AND r.accepting_queue = 1 AND r.available_slots > 0
        ),0) AS open_slots,
        COALESCE((SELECT f.amount FROM campus_fares f WHERE f.corridor_id = w.corridor_id AND f.active = 1 LIMIT 1),0) AS fare
       FROM campus_seat_watch w
       LEFT JOIN campus_route_corridors c ON c.id = w.corridor_id
       WHERE w.active = 1 AND w.notified_at = ''
         AND EXISTS (
           SELECT 1 FROM campus_rides r
           WHERE r.corridor_id = w.corridor_id AND r.status = 'OPEN' AND r.accepting_queue = 1 AND r.available_slots > 0
         )
       ORDER BY w.created_at ASC LIMIT ?`,
    [limit],
  ));

  let notified = 0;
  for (const row of rows) {
    const stamp = new Date().toISOString();
    const watchId = String(row.watch_id || "");
    const corridorId = String(row.corridor_id || "");
    const email = String(row.email || "");
    if (!watchId || !email || !corridorId) continue;
    // Claim the row before sending: a second pass, or an overlapping one, finds
    // it settled rather than writing the same promise twice.
    const claimed = await turso(
      "UPDATE campus_seat_watch SET notified_at = ?, updated_at = ? WHERE id = ? AND notified_at = ''",
      [stamp, stamp, watchId],
    );
    if (Number(claimed.affected_row_count ?? 0) === 0) continue;
    const notice = campusSeatWatchNotice({
      corridorName: String(row.corridor_name || "your campusRide route"),
      seatsOpen: Number(row.open_slots || 0),
      fare: Number(row.fare || 0),
    });
    await queueNotification(turso, {
      recipient: email,
      template: "campus_seats_open",
      subject: CAMPUS_NOTIFY_SUBJECTS.campus_seats_open,
      message: notice.message,
      reference: `campus-watch:${watchId}:${stamp}`,
      nowIso: stamp,
    }).catch(() => undefined);
    await incrementMetric("campus_watch_notified");
    notified += 1;
  }
  return { configured: true, considered: rows.length, notified };
}
