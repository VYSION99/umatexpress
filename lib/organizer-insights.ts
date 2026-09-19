import { ensureScheduledTripsTable } from "@/lib/dynamic-trips";
import { ensurePayoutTables } from "@/lib/organizer-payouts";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * What an organizer can usefully know about their own operation.
 *
 * Two questions live here. "Is someone else already running this coach?" is a
 * warning, never a refusal: two departures on the same route at the same hour
 * are legitimate — a big route supports them — but an organizer who does not
 * know they are second is being set up to lose money. "How is each trip
 * doing?" is the arithmetic of seats sold against seats offered, reading the
 * ledger for money so the numbers reconcile to the statement rather than to a
 * second guess at the fare.
 */

/** Departures within this window of each other are worth mentioning. */
export const OVERLAP_WINDOW_MINUTES = 180;

export type OverlapTrip = {
  id: string;
  title: string;
  routeFrom: string;
  routeTo: string;
  travelDate: string;
  departureTime: string;
  organizerId: string;
  organizerName: string;
  /** True when the clash is with another trip of the organizer's own. */
  own: boolean;
  minutesApart: number;
};

/** Route names are typed by people, so compare them the way a person would. */
function placeKey(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Minutes since midnight, or null for a time that cannot be parsed. A trip with
 * no usable departure time cannot be compared, so it never produces a warning:
 * a false alarm about a trip that is not really clashing would train the
 * organizer to ignore the real ones.
 */
function minutesOfDay(value: unknown) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function overlapsRoute(candidate: { routeFrom: string; routeTo: string; travelDate: string; departureTime: string }, other: OverlapTrip) {
  if (placeKey(candidate.routeFrom) !== placeKey(other.routeFrom)) return false;
  if (placeKey(candidate.routeTo) !== placeKey(other.routeTo)) return false;
  if (String(candidate.travelDate || "") !== String(other.travelDate || "")) return false;
  const candidateMinutes = minutesOfDay(candidate.departureTime);
  if (candidateMinutes === null) return false;
  return Math.abs(candidateMinutes - other.minutesApart) <= OVERLAP_WINDOW_MINUTES;
}

/**
 * Live and pending trips on the same route and date as the one being saved.
 * `excludeTripId` keeps a trip from being reported as clashing with itself.
 */
export async function findRouteOverlaps(input: {
  organizerId: string;
  routeFrom: string;
  routeTo: string;
  travelDate: string;
  departureTime: string;
  excludeTripId?: string;
}): Promise<OverlapTrip[]> {
  if (!(await isTursoConfiguredRuntime())) return [];
  const travelDate = String(input.travelDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) return [];
  const from = placeKey(input.routeFrom);
  const to = placeKey(input.routeTo);
  if (!from || !to) return [];

  await ensureScheduledTripsTable();
  // Compared in SQL on a normalised form so the database does the filtering,
  // never on the way the name happens to be typed.
  const rows = rowsToObjects(await turso(
    `SELECT t.id,COALESCE(t.title,'') AS title,COALESCE(t.route_from,'') AS route_from,COALESCE(t.route_to,'') AS route_to,
       COALESCE(t.travel_date,'') AS travel_date,COALESCE(t.departure_time,'') AS departure_time,
       COALESCE(t.organizer_id,'') AS organizer_id,COALESCE(o.name,'') AS organizer_name
     FROM scheduled_trips t LEFT JOIN trip_organizers o ON o.id = t.organizer_id
     WHERE COALESCE(t.archived,0) = 0
       AND t.review_status IN ('APPROVED','PENDING_REVIEW')
       AND t.travel_date = ?
       AND lower(trim(t.route_from)) = ? AND lower(trim(t.route_to)) = ?
       AND (? = '' OR t.id <> ?)
     ORDER BY t.departure_time ASC LIMIT 50`,
    [travelDate, from, to, String(input.excludeTripId || ""), String(input.excludeTripId || "")],
  ));

  const candidate = { ...input };
  return rows.flatMap((row): OverlapTrip[] => {
    const minutes = minutesOfDay(row.departure_time);
    if (minutes === null) return [];
    const trip: OverlapTrip = {
      id: String(row.id),
      title: String(row.title || ""),
      routeFrom: String(row.route_from || ""),
      routeTo: String(row.route_to || ""),
      travelDate: String(row.travel_date || ""),
      departureTime: String(row.departure_time || ""),
      organizerId: String(row.organizer_id || ""),
      organizerName: String(row.organizer_name || ""),
      own: String(row.organizer_id || "") === String(input.organizerId || ""),
      minutesApart: minutes,
    };
    return overlapsRoute(candidate, trip) ? [trip] : [];
  });
}

export type TripPerformance = {
  tripId: string;
  title: string;
  from: string;
  to: string;
  travelDate: string;
  departureTime: string;
  reviewStatus: string;
  active: boolean;
  capacity: number;
  booked: number;
  sellThrough: number;
  gross: number;
  commission: number;
  net: number;
  accrued: number;
  released: number;
};

/**
 * Seats sold against seats offered, and money, per trip. Money is read from the
 * ledger rather than recomputed from the fare, so a trip's earnings here are the
 * same numbers the statement shows.
 */
export async function organizerTripPerformance(organizerId: string) {
  if (!(await isTursoConfiguredRuntime())) return [] as TripPerformance[];
  await ensureScheduledTripsTable();
  await ensurePayoutTables();
  const rows = rowsToObjects(await turso(
    `SELECT t.id,COALESCE(t.title,'') AS title,COALESCE(t.route_from,'') AS route_from,COALESCE(t.route_to,'') AS route_to,
       COALESCE(t.travel_date,'') AS travel_date,COALESCE(t.departure_time,'') AS departure_time,
       COALESCE(t.review_status,'DRAFT') AS review_status,COALESCE(t.active,0) AS active,COALESCE(t.capacity,0) AS capacity,
       COALESCE(b.booked,0) AS booked,
       COALESCE(p.gross,0) AS gross,COALESCE(p.commission,0) AS commission,COALESCE(p.net,0) AS net,
       COALESCE(p.accrued,0) AS accrued,COALESCE(p.released,0) AS released
     FROM scheduled_trips t
     LEFT JOIN (
       SELECT trip_id, COUNT(*) AS booked FROM bookings WHERE booking_status = 'CONFIRMED' GROUP BY trip_id
     ) b ON b.trip_id = t.id
     LEFT JOIN (
       SELECT trip_id, SUM(gross_amount) AS gross, SUM(commission_amount) AS commission, SUM(net_amount) AS net,
         SUM(CASE WHEN status IN ('ACCRUED','PROCESSING','FAILED') THEN net_amount ELSE 0 END) AS accrued,
         SUM(CASE WHEN status = 'RELEASED' THEN net_amount ELSE 0 END) AS released
       FROM organizer_payouts GROUP BY trip_id
     ) p ON p.trip_id = t.id
     WHERE t.organizer_id = ? AND COALESCE(t.archived,0) = 0
     ORDER BY t.travel_date DESC, t.departure_time ASC LIMIT 100`,
    [organizerId],
  ));
  return rows.map((row): TripPerformance => {
    const capacity = Number(row.capacity || 0);
    const booked = Number(row.booked || 0);
    return {
      tripId: String(row.id),
      title: String(row.title || ""),
      from: String(row.route_from || ""),
      to: String(row.route_to || ""),
      travelDate: String(row.travel_date || ""),
      departureTime: String(row.departure_time || ""),
      reviewStatus: String(row.review_status || "DRAFT"),
      active: Number(row.active || 0) === 1,
      capacity,
      booked,
      // A trip with no capacity recorded is not "100% sold"; it is unknown.
      sellThrough: capacity > 0 ? Math.min(1, booked / capacity) : 0,
      gross: Number(row.gross || 0),
      commission: Number(row.commission || 0),
      net: Number(row.net || 0),
      accrued: Number(row.accrued || 0),
      released: Number(row.released || 0),
    };
  });
}

export type OrganizerInsights = {
  trips: number;
  liveTrips: number;
  seatsOffered: number;
  seatsSold: number;
  sellThrough: number;
  gross: number;
  net: number;
  accrued: number;
  released: number;
  /** The next departure still ahead of the organizer, if there is one. */
  nextDeparture: { tripId: string; title: string; travelDate: string; departureTime: string; from: string; to: string } | null;
};

const EMPTY_INSIGHTS: OrganizerInsights = {
  trips: 0, liveTrips: 0, seatsOffered: 0, seatsSold: 0, sellThrough: 0,
  gross: 0, net: 0, accrued: 0, released: 0, nextDeparture: null,
};

export async function organizerInsights(organizerId: string): Promise<OrganizerInsights> {
  const trips = await organizerTripPerformance(organizerId);
  if (!trips.length) return { ...EMPTY_INSIGHTS };
  const seatsOffered = trips.reduce((total, trip) => total + trip.capacity, 0);
  const seatsSold = trips.reduce((total, trip) => total + trip.booked, 0);
  const today = new Date().toISOString().slice(0, 10);
  const ahead = trips
    .filter((trip) => trip.travelDate >= today && trip.reviewStatus === "APPROVED")
    .sort((left, right) => `${left.travelDate}T${left.departureTime}`.localeCompare(`${right.travelDate}T${right.departureTime}`));
  const next = ahead[0];
  return {
    trips: trips.length,
    liveTrips: trips.filter((trip) => trip.reviewStatus === "APPROVED" && trip.active).length,
    seatsOffered,
    seatsSold,
    sellThrough: seatsOffered > 0 ? Math.min(1, seatsSold / seatsOffered) : 0,
    gross: trips.reduce((total, trip) => total + trip.gross, 0),
    net: trips.reduce((total, trip) => total + trip.net, 0),
    accrued: trips.reduce((total, trip) => total + trip.accrued, 0),
    released: trips.reduce((total, trip) => total + trip.released, 0),
    nextDeparture: next
      ? { tripId: next.tripId, title: next.title, travelDate: next.travelDate, departureTime: next.departureTime, from: next.from, to: next.to }
      : null,
  };
}
