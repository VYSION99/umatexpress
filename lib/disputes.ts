import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureScheduledTripsTable } from "@/lib/dynamic-trips";
import { ensureBookingsTable, isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Disputes: a passenger or an organizer saying something went wrong, and the
 * record of what the platform decided.
 *
 * This records decisions; it does not move money. A REFUND decision is a
 * judgement that the passenger should be repaid, and the repayment itself is
 * made where every other money movement is made. What the record buys is that
 * the reason, the evidence and the person who decided sit in one place, which
 * is exactly what is missing when a complaint arrives by phone.
 *
 * Scoping follows the rest of the console: an organizer sees disputes about
 * their own trips, a student sees the ones they raised, and only an
 * administrator sees everything and resolves anything.
 */

export const DISPUTE_CATEGORIES = ["BOOKING", "REFUND", "TRIP_CANCELLED", "DELAY", "CONDUCT", "PAYMENT", "OTHER"] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const DISPUTE_STATUSES = ["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_RESOLUTIONS = ["REFUND", "PARTIAL_REFUND", "RELEASE_PAYOUT", "NO_ACTION", "OTHER"] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

const DISPUTES_SCHEMA_VERSION = "2026-09-18.1";

const DISPUTES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trip_disputes (
    id TEXT PRIMARY KEY,
    organizer_id TEXT NOT NULL DEFAULT '',
    trip_id TEXT NOT NULL DEFAULT '',
    booking_reference TEXT NOT NULL DEFAULT '',
    raised_by_role TEXT NOT NULL DEFAULT '',
    raised_by TEXT NOT NULL DEFAULT '',
    raised_by_contact TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'OTHER',
    subject TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN',
    resolution TEXT NOT NULL DEFAULT '',
    resolution_note TEXT NOT NULL DEFAULT '',
    resolved_by TEXT NOT NULL DEFAULT '',
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_trip_disputes_status ON trip_disputes(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_trip_disputes_organizer ON trip_disputes(organizer_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_trip_disputes_reference ON trip_disputes(booking_reference)",
];

let disputesReady: Promise<void> | null = null;

export function ensureDisputeTables() {
  disputesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "tripDisputes",
    version: DISPUTES_SCHEMA_VERSION,
    statements: DISPUTES_SCHEMA_STATEMENTS,
  }).catch((error: unknown) => {
    disputesReady = null;
    throw error;
  });
  return disputesReady;
}

export function isDisputeCategory(value: unknown): value is DisputeCategory {
  return (DISPUTE_CATEGORIES as readonly string[]).includes(String(value || "").trim().toUpperCase());
}

export function isDisputeResolution(value: unknown): value is DisputeResolution {
  return (DISPUTE_RESOLUTIONS as readonly string[]).includes(String(value || "").trim().toUpperCase());
}

export function isDisputeStatus(value: unknown): value is DisputeStatus {
  return (DISPUTE_STATUSES as readonly string[]).includes(String(value || "").trim().toUpperCase());
}

export type Dispute = {
  id: string;
  organizerId: string;
  organizerName: string;
  tripId: string;
  bookingReference: string;
  raisedByRole: string;
  raisedBy: string;
  category: string;
  subject: string;
  details: string;
  status: string;
  resolution: string;
  resolutionNote: string;
  resolvedBy: string;
  resolvedAt: string;
  createdAt: string;
  updatedAt: string;
};

const DISPUTE_COLUMNS = `d.id,COALESCE(d.organizer_id,'') AS organizer_id,COALESCE(o.name,'') AS organizer_name,
  COALESCE(d.trip_id,'') AS trip_id,COALESCE(d.booking_reference,'') AS booking_reference,
  COALESCE(d.raised_by_role,'') AS raised_by_role,COALESCE(d.raised_by,'') AS raised_by,
  COALESCE(d.category,'OTHER') AS category,COALESCE(d.subject,'') AS subject,COALESCE(d.details,'') AS details,
  COALESCE(d.status,'OPEN') AS status,COALESCE(d.resolution,'') AS resolution,
  COALESCE(d.resolution_note,'') AS resolution_note,COALESCE(d.resolved_by,'') AS resolved_by,
  COALESCE(d.resolved_at,'') AS resolved_at,d.created_at,d.updated_at`;

function disputeView(row: Record<string, unknown>): Dispute {
  return {
    id: String(row.id),
    organizerId: String(row.organizer_id || ""),
    organizerName: String(row.organizer_name || ""),
    tripId: String(row.trip_id || ""),
    bookingReference: String(row.booking_reference || ""),
    raisedByRole: String(row.raised_by_role || ""),
    raisedBy: String(row.raised_by || ""),
    category: String(row.category || "OTHER"),
    subject: String(row.subject || ""),
    details: String(row.details || ""),
    status: String(row.status || "OPEN"),
    resolution: String(row.resolution || ""),
    resolutionNote: String(row.resolution_note || ""),
    resolvedBy: String(row.resolved_by || ""),
    resolvedAt: String(row.resolved_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export type OpenDisputeInput = {
  /** STUDENT sessions pass the account email; organizer sessions pass their organizer id. */
  raisedByRole: "STUDENT" | "ORGANIZER";
  raisedBy: string;
  contact: string;
  bookingReference?: unknown;
  tripId?: unknown;
  category?: unknown;
  subject?: unknown;
  details?: unknown;
};

/**
 * The ownership check is the whole security story here, so it happens before
 * anything is written: a student may only dispute a booking made with their own
 * account email, and an organizer only one of their own trips. The trip and
 * organizer are then copied from the booking rather than taken from the
 * request, so a dispute can never be filed against someone else's row.
 */
export async function openDispute(input: OpenDisputeInput): Promise<Dispute> {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Disputes are not available on this deployment.", 503);
  }
  await ensureDisputeTables();
  await ensureBookingsTable();
  await ensureScheduledTripsTable();

  const subject = String(input.subject || "").trim().slice(0, 120);
  const details = String(input.details || "").trim().slice(0, 2000);
  if (subject.length < 4) throw new CampusEngineError("VALIDATION_ERROR", "Give the issue a short title.", 400);
  if (details.length < 20) {
    throw new CampusEngineError("VALIDATION_ERROR", "Describe what happened in at least a sentence or two.", 400);
  }
  const category = isDisputeCategory(input.category) ? String(input.category).trim().toUpperCase() : "OTHER";
  const bookingReference = String(input.bookingReference || "").trim();
  const tripId = String(input.tripId || "").trim();
  if (!bookingReference && !tripId) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give the booking reference this is about.", 400);
  }

  let organizerId = "";
  let resolvedTripId = tripId;
  if (bookingReference) {
    const booking = rowsToObjects(await turso(
      `SELECT b.id,b.email,b.trip_id,COALESCE(b.organizer_id,'') AS organizer_id,
         COALESCE(t.organizer_id,'') AS trip_organizer_id
       FROM bookings b LEFT JOIN scheduled_trips t ON t.id = b.trip_id
       WHERE b.reference = ? LIMIT 1`,
      [bookingReference],
    ))[0];
    if (!booking) throw new CampusEngineError("NOT_FOUND", "No booking carries that reference.", 404);
    if (input.raisedByRole === "STUDENT") {
      // Matched on the account email rather than a claimed one, so a guessed
      // reference cannot reach a stranger's booking.
      if (String(booking.email || "").trim().toLowerCase() !== String(input.raisedBy || "").trim().toLowerCase()) {
        throw new CampusEngineError("FORBIDDEN", "That booking was not made with your account.", 403);
      }
    } else {
      const owner = String(booking.organizer_id || booking.trip_organizer_id || "");
      if (!owner || owner !== String(input.raisedBy)) {
        throw new CampusEngineError("FORBIDDEN", "That booking is not on your trip.", 403);
      }
      organizerId = owner;
    }
    resolvedTripId = String(booking.trip_id || resolvedTripId);
    organizerId = organizerId || String(booking.organizer_id || booking.trip_organizer_id || "");
  }

  if (!organizerId && resolvedTripId) {
    const trip = rowsToObjects(await turso(
      "SELECT COALESCE(organizer_id,'') AS organizer_id FROM scheduled_trips WHERE id = ? LIMIT 1",
      [resolvedTripId],
    ))[0];
    if (!trip) throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);
    organizerId = String(trip.organizer_id || "");
    if (input.raisedByRole === "ORGANIZER" && organizerId !== String(input.raisedBy)) {
      throw new CampusEngineError("FORBIDDEN", "That trip is not yours.", 403);
    }
  }

  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO trip_disputes (id,organizer_id,trip_id,booking_reference,raised_by_role,raised_by,raised_by_contact,category,subject,details,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)`,
    [
      id, organizerId, resolvedTripId, bookingReference,
      input.raisedByRole, String(input.raisedBy || ""), String(input.contact || "").slice(0, 200),
      category, subject, details, stamp, stamp,
    ],
  );
  await consoleAudit({
    actor: String(input.raisedBy || ""),
    action: "DISPUTE_OPENED",
    targetType: "trip_dispute",
    targetReference: id,
    details: { role: input.raisedByRole, category, organizerId, bookingReference },
  }).catch(() => undefined);
  return disputeView({
    id, organizer_id: organizerId, trip_id: resolvedTripId, booking_reference: bookingReference,
    raised_by_role: input.raisedByRole, raised_by: input.raisedBy, category, subject, details,
    status: "OPEN", created_at: stamp, updated_at: stamp,
  });
}

/** A student's own disputes, newest first. */
export async function listStudentDisputes(email: string) {
  if (!(await isTursoConfiguredRuntime())) return [] as Dispute[];
  await ensureDisputeTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${DISPUTE_COLUMNS} FROM trip_disputes d LEFT JOIN trip_organizers o ON o.id = d.organizer_id
     WHERE d.raised_by_role = 'STUDENT' AND lower(d.raised_by) = ?
     ORDER BY d.created_at DESC LIMIT 50`,
    [String(email || "").trim().toLowerCase()],
  ));
  return rows.map(disputeView);
}

/**
 * Disputes about an organizer's trips. The contact column is deliberately not
 * selected: the organizer already has the passenger number on the trip
 * manifest, and a dispute record is not a second contact list.
 */
export async function listOrganizerDisputes(organizerId: string) {
  if (!(await isTursoConfiguredRuntime())) return [] as Dispute[];
  await ensureDisputeTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${DISPUTE_COLUMNS} FROM trip_disputes d LEFT JOIN trip_organizers o ON o.id = d.organizer_id
     WHERE d.organizer_id = ? ORDER BY (d.status IN ('OPEN','REVIEWING')) DESC, d.created_at DESC LIMIT 100`,
    [organizerId],
  ));
  return rows.map(disputeView);
}

/** Everything, for the console that resolves them. */
export async function listDisputes(input: { status?: string; limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { disputes: [] as Dispute[], counts: {} as Record<string, number> };
  await ensureDisputeTables();
  const status = isDisputeStatus(input.status) ? String(input.status).toUpperCase() : "";
  const limit = Math.max(1, Math.min(200, Math.round(Number(input.limit) || 100)));
  const rows = rowsToObjects(await turso(
    `SELECT ${DISPUTE_COLUMNS} FROM trip_disputes d LEFT JOIN trip_organizers o ON o.id = d.organizer_id
     WHERE (? = '' OR d.status = ?)
     ORDER BY (d.status IN ('OPEN','REVIEWING')) DESC, d.created_at DESC LIMIT ?`,
    [status, status, limit],
  ));
  const grouped = rowsToObjects(await turso("SELECT status, COUNT(*) AS total FROM trip_disputes GROUP BY status"));
  const counts: Record<string, number> = {};
  for (const row of grouped) counts[String(row.status)] = Number(row.total || 0);
  return { disputes: rows.map(disputeView), counts };
}

/**
 * The decision. Resolving is ADMIN work and is audited with the actor, the
 * outcome and the note, so a decision can always be traced to a person and an
 * explanation. Moving the money the decision implies is a separate act.
 */
export async function resolveDispute(input: {
  disputeId: string;
  status?: unknown;
  resolution?: unknown;
  note?: unknown;
  actor: string;
}) {
  await ensureDisputeTables();
  const disputeId = String(input.disputeId || "").trim();
  if (!disputeId) throw new CampusEngineError("VALIDATION_ERROR", "Which dispute?", 400);
  const existing = rowsToObjects(await turso("SELECT id,status FROM trip_disputes WHERE id = ? LIMIT 1", [disputeId]))[0];
  if (!existing) throw new CampusEngineError("NOT_FOUND", "That dispute was not found.", 404);

  const status = isDisputeStatus(input.status) ? String(input.status).toUpperCase() : "RESOLVED";
  const resolution = isDisputeResolution(input.resolution) ? String(input.resolution).toUpperCase() : "NO_ACTION";
  const note = String(input.note || "").trim().slice(0, 1000);
  if (status === "RESOLVED" && note.length < 4) {
    throw new CampusEngineError("VALIDATION_ERROR", "Record what was decided and why.", 400);
  }
  const stamp = new Date().toISOString();
  if (status === "REVIEWING") {
    // Taking a dispute in hand is not a decision, so the outcome stays open.
    await turso("UPDATE trip_disputes SET status = 'REVIEWING', updated_at = ? WHERE id = ?", [stamp, disputeId]);
  } else {
    await turso(
      "UPDATE trip_disputes SET status = ?, resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
      [status, resolution, note, String(input.actor || ""), stamp, stamp, disputeId],
    );
  }
  await consoleAudit({
    actor: String(input.actor || ""),
    action: status === "REVIEWING" ? "DISPUTE_REVIEWING" : `DISPUTE_${status}`,
    targetType: "trip_dispute",
    targetReference: disputeId,
    details: { status, resolution, note, from: String(existing.status || "") },
  });
  return { id: disputeId, status, resolution };
}
