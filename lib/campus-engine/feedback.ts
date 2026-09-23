import { CampusEngineError } from "@/lib/campus-engine/errors";
import { openDispute, type Dispute } from "@/lib/disputes";
import { incrementMetric } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * What a passenger thought of the ride, and what they want done about it.
 *
 * The two are deliberately different acts with different homes, because they
 * are different kinds of thing. A **rating** is a score on a driver's record —
 * nobody has to decide anything, and the only useful thing to do with it is to
 * watch it. A **report** is a complaint that needs a person, so it is filed in
 * the dispute queue the console already reads, carrying the ride it is about.
 *
 * That division is also what keeps the rating honest. A rating that becomes a
 * complaint is a rating a driver learns to game; a complaint that becomes a
 * rating is a passenger believing nobody read it.
 */

export const RATING_SCHEMA_VERSION = "2026-09-24.1";

const CAMPUS_RATING_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS campus_ratings (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    driver_id TEXT NOT NULL DEFAULT '',
    corridor_id TEXT NOT NULL DEFAULT '',
    passenger_email TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // One rating per seat: a passenger who changes their mind edits it rather
  // than stacking a second vote on the same trip.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_ratings_entry ON campus_ratings(entry_id)",
  "CREATE INDEX IF NOT EXISTS idx_campus_ratings_driver ON campus_ratings(driver_id, created_at DESC)",
];

let ratingTablesReady: Promise<void> | null = null;

export function ensureCampusRatingTables() {
  ratingTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "campusRatings",
    version: RATING_SCHEMA_VERSION,
    statements: CAMPUS_RATING_STATEMENTS,
  }).catch((error: unknown) => {
    ratingTablesReady = null;
    throw error;
  });
  return ratingTablesReady;
}

export type CampusRating = {
  id: string;
  entryId: string;
  reference: string;
  driverId: string;
  driverName: string;
  corridorId: string;
  passengerEmail: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
};

/** The trip a rating or a report is about, as the authorisation needs it. */
export type CampusRatedTrip = {
  id: string;
  reference: string;
  email: string;
  queueStatus: string;
  driverId: string;
  corridorId: string;
};

const RATING_COLUMNS = `rt.id,rt.entry_id,COALESCE(rt.reference,'') AS reference,COALESCE(rt.driver_id,'') AS driver_id,
  COALESCE(d.name,'') AS driver_name,COALESCE(rt.corridor_id,'') AS corridor_id,
  COALESCE(rt.passenger_email,'') AS passenger_email,rt.rating,COALESCE(rt.comment,'') AS comment,
  rt.created_at,rt.updated_at`;

function ratingView(row: Record<string, unknown>): CampusRating {
  return {
    id: String(row.id),
    entryId: String(row.entry_id || ""),
    reference: String(row.reference || ""),
    driverId: String(row.driver_id || ""),
    driverName: String(row.driver_name || ""),
    corridorId: String(row.corridor_id || ""),
    passengerEmail: String(row.passenger_email || ""),
    rating: Number(row.rating || 0),
    comment: String(row.comment || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

/**
 * Loads the seat a rating or report is about. This is also the authorisation:
 * the caller compares the stored email with the account or the payment token,
 * so a guessed reference can never score or complain about a stranger's ride.
 */
export async function loadCampusRatedTrip(reference: string): Promise<CampusRatedTrip | null> {
  if (!(await isTursoConfiguredRuntime())) return null;
  const row = rowsToObjects(await turso(
    `SELECT q.id,q.reference,COALESCE(q.email,'') AS email,q.queue_status,
        COALESCE(r.driver_id,'') AS driver_id,COALESCE(q.corridor_id,'') AS corridor_id
       FROM campus_queue_entries q
       LEFT JOIN campus_rides r ON r.id = q.ride_id
       WHERE q.reference = ? LIMIT 1`,
    [String(reference || "")],
  ))[0];
  if (!row) return null;
  return {
    id: String(row.id),
    reference: String(row.reference || ""),
    email: String(row.email || ""),
    queueStatus: String(row.queue_status || ""),
    driverId: String(row.driver_id || ""),
    corridorId: String(row.corridor_id || ""),
  };
}

/** Only a finished trip can be rated or complained about — there is nothing to judge before then. */
function assertTripFinished(trip: CampusRatedTrip) {
  if (String(trip.queueStatus).toUpperCase() !== "COMPLETED") {
    throw new CampusEngineError("INVALID_STATE", "You can rate or report this trip once it is complete.", 409);
  }
}

export async function rateCampusTrip(input: { reference: string; rating: unknown; comment?: unknown; email: string }) {
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Ratings are not available on this deployment.", 503);
  await ensureCampusRatingTables();
  const trip = await loadCampusRatedTrip(input.reference);
  if (!trip) throw new CampusEngineError("NOT_FOUND", "That campusRide seat was not found.", 404);
  assertTripFinished(trip);
  const score = Math.round(Number(input.rating) || 0);
  if (score < 1 || score > 5) throw new CampusEngineError("VALIDATION_ERROR", "Choose a rating from one to five.", 400);
  const comment = String(input.comment || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const stamp = new Date().toISOString();
  const existing = rowsToObjects(await turso("SELECT id FROM campus_ratings WHERE entry_id = ? LIMIT 1", [trip.id]))[0];
  if (existing) {
    // A second thought is allowed and is still one rating, so an edit cannot
    // move a driver's average twice for the same trip.
    await turso(
      "UPDATE campus_ratings SET rating = ?, comment = ?, updated_at = ? WHERE entry_id = ?",
      [score, comment, stamp, trip.id],
    );
    await incrementMetric("campus_rating_updated");
    return (await getCampusRatingByEntry(trip.id)) as CampusRating;
  }
  const id = crypto.randomUUID();
  await turso(
    `INSERT INTO campus_ratings (id,entry_id,reference,driver_id,corridor_id,passenger_email,rating,comment,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, trip.id, trip.reference, trip.driverId, trip.corridorId, String(input.email || "").trim().toLowerCase(), score, comment, stamp, stamp],
  );
  await incrementMetric("campus_rating_created");
  return (await getCampusRatingByEntry(trip.id)) as CampusRating;
}

export async function getCampusRatingByEntry(entryId: string) {
  await ensureCampusRatingTables();
  const row = rowsToObjects(await turso(
    `SELECT ${RATING_COLUMNS} FROM campus_ratings rt LEFT JOIN campus_drivers d ON d.id = rt.driver_id WHERE rt.entry_id = ? LIMIT 1`,
    [String(entryId || "")],
  ))[0];
  return row ? ratingView(row) : null;
}

export async function listCampusRatings(options: { driverId?: string; limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return [] as CampusRating[];
  await ensureCampusRatingTables();
  const limit = Math.max(1, Math.min(200, Math.round(options.limit || 50)));
  const rows = options.driverId
    ? await turso(`SELECT ${RATING_COLUMNS} FROM campus_ratings rt LEFT JOIN campus_drivers d ON d.id = rt.driver_id WHERE rt.driver_id = ? ORDER BY rt.created_at DESC LIMIT ?`, [String(options.driverId), limit])
    : await turso(`SELECT ${RATING_COLUMNS} FROM campus_ratings rt LEFT JOIN campus_drivers d ON d.id = rt.driver_id ORDER BY rt.created_at DESC LIMIT ?`, [limit]);
  return rowsToObjects(rows).map(ratingView);
}

/**
 * How many ratings a driver needs before an average is shown at all.
 *
 * Below this the number is noise that reads as a verdict: one bad trip out of
 * two is not a 2.5-star driver, and showing it as one teaches drivers to avoid
 * the passengers most likely to complain — which is the opposite of what a
 * rating is for. The count is always shown, so the record is never hidden.
 */
export const CAMPUS_RATING_VISIBLE_COUNT = 3;

export type CampusRatingSummary = { average: number; count: number; lastAt: string; visible: boolean };

/** A driver's own running average. Nobody sees a single review, only the record. */
export async function campusDriverRatingSummary(driverId: string): Promise<CampusRatingSummary> {
  const empty = { average: 0, count: 0, lastAt: "", visible: false };
  if (!(await isTursoConfiguredRuntime())) return empty;
  await ensureCampusRatingTables();
  const row = rowsToObjects(await turso(
    "SELECT COUNT(*) AS total, COALESCE(AVG(rating),0) AS average, COALESCE(MAX(created_at),'') AS last_at FROM campus_ratings WHERE driver_id = ?",
    [String(driverId || "")],
  ))[0];
  const count = Number(row?.total || 0);
  const visible = count >= CAMPUS_RATING_VISIBLE_COUNT;
  // Suppressed rather than merely unlabelled: a consumer that forgets to check
  // `visible` still cannot leak a two-trip average as if it were a verdict.
  return { average: visible ? Math.round(Number(row?.average || 0) * 10) / 10 : 0, count, lastAt: String(row?.last_at || ""), visible };
}

/**
 * One row per driver, worst average first.
 *
 * The order is the point: a rating that nobody reads is decoration, and the
 * only question operations has is "which runs need a look" — which is answered
 * by the weakest average, not by the newest comment.
 */
export async function campusRatingBreakdown() {
  if (!(await isTursoConfiguredRuntime())) return { overall: { average: 0, count: 0 }, byDriver: [] as Array<{ driverId: string; driverName: string; trips: number; average: number }> };
  await ensureCampusRatingTables();
  const rows = rowsToObjects(await turso(
    `SELECT rt.driver_id,COALESCE(d.name,'Unassigned') AS driver_name,COUNT(*) AS trips,AVG(rt.rating) AS average
     FROM campus_ratings rt LEFT JOIN campus_drivers d ON d.id = rt.driver_id
     GROUP BY rt.driver_id, d.name ORDER BY average ASC, trips DESC LIMIT 100`,
  ));
  const byDriver = rows.map((row) => ({
    driverId: String(row.driver_id || ""),
    driverName: String(row.driver_name || "Unassigned"),
    trips: Number(row.trips || 0),
    average: Math.round(Number(row.average || 0) * 10) / 10,
  }));
  const count = byDriver.reduce((total, row) => total + row.trips, 0);
  const average = count ? Math.round((byDriver.reduce((total, row) => total + row.average * row.trips, 0) / count) * 10) / 10 : 0;
  return { overall: { average, count }, byDriver };
}

/** What the ticket should offer for one seat. */
export async function campusFeedbackState(reference: string, email: string) {
  const trip = await loadCampusRatedTrip(reference);
  if (!trip) return { found: false, completed: false, canRate: false, canReport: false, rating: null as CampusRating | null, domainEmail: email };
  const completed = String(trip.queueStatus).toUpperCase() === "COMPLETED";
  const rating = completed ? await getCampusRatingByEntry(trip.id) : null;
  return { found: true, completed, canRate: completed, canReport: completed, rating, domainEmail: trip.email };
}

const REPORT_TITLES: Record<string, string> = {
  DELAY: "The campusRide trip was late",
  CONDUCT: "A concern about the driver's conduct",
  PAYMENT: "Something wrong with the campusRide payment",
  TRIP_CANCELLED: "The campusRide trip was cancelled",
  BOOKING: "A problem with the campusRide booking",
  OTHER: "Something went wrong on a campusRide trip",
};

/**
 * A complaint, filed where complaints are read.
 *
 * The student writes one thing — what happened — and the subject is derived
 * from the category they picked, because asking someone who is upset to also
 * title their own complaint is how a complaint stays unwritten.
 */
export async function reportCampusTrip(input: { reference: string; category?: unknown; details?: unknown; email: string; contact?: string }): Promise<Dispute> {
  const trip = await loadCampusRatedTrip(input.reference);
  if (!trip) throw new CampusEngineError("NOT_FOUND", "That campusRide seat was not found.", 404);
  assertTripFinished(trip);
  const category = String(input.category || "OTHER").trim().toUpperCase();
  const details = String(input.details || "").replace(/\s+/g, " ").trim();
  if (details.length < 20) {
    throw new CampusEngineError("VALIDATION_ERROR", "Describe what happened in at least a sentence or two.", 400);
  }
  const dispute = await openDispute({
    raisedByRole: "STUDENT",
    raisedBy: String(input.email || "").trim().toLowerCase(),
    contact: String(input.contact || input.email || ""),
    campusReference: trip.reference,
    category,
    subject: (REPORT_TITLES[category] || REPORT_TITLES.OTHER).slice(0, 120),
    details,
  });
  await incrementMetric("campus_report_filed");
  return dispute;
}
