import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureScheduledTripsTable } from "@/lib/dynamic-trips";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * The trip lifecycle for organizers.
 *
 * Approval is mandatory: nothing an organizer writes is bookable until a
 * reviewer approves it. That is why an edit to a live trip returns it to
 * `PENDING_REVIEW` rather than publishing silently — the rule is only worth
 * anything if it also covers changes.
 *
 *     DRAFT ─┐
 *  REJECTED ─┴─▶ PENDING_REVIEW ─▶ APPROVED ─▶ SUSPENDED
 *                        └──────▶ REJECTED        └─▶ PENDING_REVIEW
 */
export const REVIEW_STATUSES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED", "SUSPENDED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const MAX_AMENITIES = 12;

export type OrganizerTripInput = {
  title?: unknown;
  from?: unknown;
  to?: unknown;
  travelDate?: unknown;
  departureTime?: unknown;
  arrivalTime?: unknown;
  price?: unknown;
  capacity?: unknown;
  coachType?: unknown;
  tag?: unknown;
  amenities?: unknown;
  notes?: unknown;
};

export type NormalizedTrip = {
  title: string;
  routeFrom: string;
  routeTo: string;
  travelDate: string;
  departureTime: string;
  arrivalTime: string;
  price: number;
  capacity: number;
  coachType: string;
  tag: string;
  amenities: string[];
  notes: string;
};

function text(value: unknown, field: string, max: number, required = true) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) {
    if (!required) return "";
    throw new CampusEngineError("VALIDATION_ERROR", `Enter the ${field}.`, 400);
  }
  if (cleaned.length > max) {
    throw new CampusEngineError("VALIDATION_ERROR", `Keep the ${field} under ${max} characters.`, 400);
  }
  return cleaned;
}

function list(value: unknown) {
  const items = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return items.slice(0, MAX_AMENITIES);
}

/**
 * Validated trip fields. Kept separate from the write so the same rules run on
 * create and on edit, and so the admin route can share them.
 */
export function normalizeOrganizerTrip(input: OrganizerTripInput): NormalizedTrip {
  const title = text(input.title, "trip title", 120);
  const routeFrom = text(input.from, "starting point", 80);
  const routeTo = text(input.to, "destination", 80);
  const travelDate = text(input.travelDate, "travel date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || Number.isNaN(Date.parse(`${travelDate}T00:00:00Z`))) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter the travel date as YYYY-MM-DD.", 400);
  }
  const departureTime = text(input.departureTime, "departure time", 5);
  const arrivalTime = text(input.arrivalTime, "arrival time", 5);
  for (const [label, value] of [["departure", departureTime], ["arrival", arrivalTime]] as const) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new CampusEngineError("VALIDATION_ERROR", `Enter the ${label} time as HH:MM.`, 400);
    }
  }
  const price = Math.round(Number(input.price));
  if (!Number.isFinite(price) || price <= 0 || price > 100_000) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter a fare between 1 and 100,000 GHS.", 400);
  }
  const capacity = Math.round(Number(input.capacity));
  if (!Number.isFinite(capacity) || capacity < 1 || capacity > 80) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter a seat count between 1 and 80.", 400);
  }
  return {
    title,
    routeFrom,
    routeTo,
    travelDate,
    departureTime,
    arrivalTime,
    price,
    capacity,
    coachType: text(input.coachType, "coach type", 60, false) || "VIP Coach",
    tag: text(input.tag, "tag", 60, false),
    amenities: list(input.amenities),
    notes: text(input.notes, "notes", 600, false),
  };
}

async function ownedTrip(organizerId: string, tripId: string) {
  return rowsToObjects(await turso(
    "SELECT id,review_status FROM scheduled_trips WHERE id = ? AND organizer_id = ? LIMIT 1",
    [tripId, organizerId],
  ))[0];
}

export async function createOrganizerTrip(organizerId: string, input: OrganizerTripInput) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Trip publishing is not available on this deployment.", 503);
  }
  await ensureScheduledTripsTable();
  const trip = normalizeOrganizerTrip(input);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO scheduled_trips (id,title,route_from,route_to,travel_date,departure_time,arrival_time,price,capacity,coach_type,tag,amenities,notes,active,archived,display_order,organizer_id,review_status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,'DRAFT',?,?)`,
    [id, trip.title, trip.routeFrom, trip.routeTo, trip.travelDate, trip.departureTime, trip.arrivalTime, trip.price, trip.capacity, trip.coachType, trip.tag, JSON.stringify(trip.amenities), trip.notes, organizerId, stamp, stamp],
  );
  await consoleAudit({
    actor: organizerId,
    action: "ORGANIZER_TRIP_CREATED",
    targetType: "scheduled_trip",
    targetReference: id,
    details: { route: `${trip.routeFrom} → ${trip.routeTo}`, travelDate: trip.travelDate },
  }).catch(() => undefined);
  // A new trip starts inactive: `active` is only turned on at approval, so a
  // forgotten column can never publish one.
  return { id, reviewStatus: "DRAFT" as ReviewStatus };
}

export async function updateOrganizerTrip(organizerId: string, tripId: string, input: OrganizerTripInput) {
  await ensureScheduledTripsTable();
  const existing = await ownedTrip(organizerId, tripId);
  // A trip that exists but belongs to someone else must look absent, so an
  // organizer cannot probe for ids they do not own.
  if (!existing) throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);
  const trip = normalizeOrganizerTrip(input);
  const stamp = new Date().toISOString();
  const wasLive = String(existing.review_status) === "APPROVED";
  // Editing a live trip sends it back for review: nothing an organizer writes
  // reaches students unreviewed, and a silent edit would break that promise.
  const nextStatus = wasLive ? "PENDING_REVIEW" : String(existing.review_status || "DRAFT");
  await turso(
    `UPDATE scheduled_trips SET title=?,route_from=?,route_to=?,travel_date=?,departure_time=?,arrival_time=?,price=?,capacity=?,coach_type=?,tag=?,amenities=?,notes=?,review_status=?,active=?,updated_at=?
     WHERE id=? AND organizer_id=?`,
    [trip.title, trip.routeFrom, trip.routeTo, trip.travelDate, trip.departureTime, trip.arrivalTime, trip.price, trip.capacity, trip.coachType, trip.tag, JSON.stringify(trip.amenities), trip.notes, nextStatus, nextStatus === "APPROVED" ? 1 : 0, stamp, tripId, organizerId],
  );
  await consoleAudit({
    actor: organizerId,
    action: "ORGANIZER_TRIP_UPDATED",
    targetType: "scheduled_trip",
    targetReference: tripId,
    details: { from: String(existing.review_status || "DRAFT"), to: nextStatus, resubmitted: wasLive },
  }).catch(() => undefined);
  return { id: tripId, reviewStatus: nextStatus as ReviewStatus, resubmitted: wasLive };
}

export async function archiveOrganizerTrip(organizerId: string, tripId: string) {
  await ensureScheduledTripsTable();
  const existing = await ownedTrip(organizerId, tripId);
  if (!existing) throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);
  if (String(existing.review_status) === "APPROVED") {
    throw new CampusEngineError("INVALID_STATE", "Ask an administrator to pull a live trip before you remove it.", 409);
  }
  await turso("UPDATE scheduled_trips SET archived = 1, active = 0, updated_at = ? WHERE id = ? AND organizer_id = ?", [new Date().toISOString(), tripId, organizerId]);
  return { id: tripId, archived: true };
}

/** `SUBMIT` is the organizer's move; the rest belong to a reviewer. */
export async function reviewOrganizerTrip(input: {
  tripId: string;
  action: "SUBMIT" | "APPROVE" | "REJECT" | "SUSPEND";
  reason?: string;
  actor: string;
  organizerId?: string;
}) {
  await ensureScheduledTripsTable();
  const tripId = String(input.tripId || "").trim();
  if (!tripId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a trip.", 400);
  const row = rowsToObjects(await turso(
    "SELECT id,organizer_id,review_status FROM scheduled_trips WHERE id = ? LIMIT 1",
    [tripId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);

  const current = String(row.review_status || "DRAFT");
  const reason = String(input.reason || "").trim();
  const stamp = new Date().toISOString();

  // An organizer may only submit their own trip, and only from a state that is
  // waiting on them. Staff review trips the platform owns too, so the owner
  // check applies to the organizer's move alone.
  if (input.action === "SUBMIT") {
    if (!input.organizerId || String(row.organizer_id || "") !== input.organizerId) {
      throw new CampusEngineError("NOT_FOUND", "That trip was not found.", 404);
    }
    if (!["DRAFT", "REJECTED", "SUSPENDED"].includes(current)) {
      throw new CampusEngineError("INVALID_STATE", "This trip is already with a reviewer.", 409);
    }
  }

  const transitions: Record<string, { from: string[]; to: ReviewStatus }> = {
    APPROVE: { from: ["PENDING_REVIEW"], to: "APPROVED" },
    REJECT: { from: ["PENDING_REVIEW"], to: "REJECTED" },
    SUSPEND: { from: ["APPROVED"], to: "SUSPENDED" },
  };

  if (input.action === "SUBMIT") {
    await turso("UPDATE scheduled_trips SET review_status='PENDING_REVIEW', review_reason='', submitted_at=?, updated_at=? WHERE id=?", [stamp, stamp, tripId]);
  } else {
    const transition = transitions[input.action];
    if (!transition.from.includes(current)) {
      throw new CampusEngineError("INVALID_STATE", `A ${current.toLowerCase().replace("_", " ")} trip cannot be ${input.action.toLowerCase()}d.`, 409);
    }
    if ((input.action === "REJECT" || input.action === "SUSPEND") && !reason) {
      throw new CampusEngineError("VALIDATION_ERROR", "Give a reason so the organizer knows what to change.", 400);
    }
    // `active` follows the decision, so visibility is decided in one place.
    await turso(
      "UPDATE scheduled_trips SET review_status=?, review_reason=?, reviewed_at=?, reviewed_by=?, active=?, updated_at=? WHERE id=?",
      [transition.to, transition.to === "APPROVED" ? "" : reason, stamp, input.actor, transition.to === "APPROVED" ? 1 : 0, stamp, tripId],
    );
  }

  await consoleAudit({
    actor: input.actor,
    action: `TRIP_${input.action}`,
    targetType: "scheduled_trip",
    targetReference: tripId,
    details: { from: current, reason },
  });

  const decision = input.action === "SUBMIT" ? "PENDING_REVIEW" : transitions[input.action].to;
  return { id: tripId, reviewStatus: decision as ReviewStatus };
}

/** The review queue: every trip waiting on a decision, oldest first. */
export async function listTripsAwaitingReview() {
  await ensureScheduledTripsTable();
  const rows = rowsToObjects(await turso(
    `SELECT t.id,t.title,t.route_from,t.route_to,t.travel_date,t.departure_time,t.arrival_time,t.price,t.capacity,t.coach_type,
       COALESCE(t.review_status,'DRAFT') AS review_status,COALESCE(t.organizer_id,'') AS organizer_id,COALESCE(t.submitted_at,'') AS submitted_at,
       COALESCE(o.organization,'') AS organization,COALESCE(o.name,'') AS organizer_name
     FROM scheduled_trips t LEFT JOIN trip_organizers o ON o.id = t.organizer_id
     WHERE t.review_status = 'PENDING_REVIEW' AND COALESCE(t.archived,0) = 0
     ORDER BY t.submitted_at ASC, t.updated_at ASC`,
  ));
  return rows.map((row) => ({
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
    organizerId: String(row.organizer_id || ""),
    organizerName: String(row.organization || row.organizer_name || ""),
    submittedAt: String(row.submitted_at || ""),
    platformOwned: !String(row.organizer_id || ""),
  }));
}
