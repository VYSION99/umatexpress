import { ensureCampusRideTables } from "@/lib/campus-ride";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { estimateWaitMinutes, queueProgress, waitLabel } from "@/lib/campus-engine/progress";
import { hashPaymentToken, paymentTokenFromRequest } from "@/lib/payment-access";
import { incrementMetric } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

const ACTIVE_STATUSES = new Set(["PAID_WAITING", "ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED", "BOARDED"]);
const ACTIVE_SQL = "'PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED'";

/**
 * Live progress for one paid queue entry, for the passenger's ticket page.
 * Authorised by the same per-payment token as `verifyCampusRidePayment`; the
 * boarding PIN is deliberately not returned here.
 */
export async function campusQueueStatus(request: Request, reference: string) {
  if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing campusRide payment reference.", 400);
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before tracking campusRide rides.", 503);
  await ensureCampusRideTables();

  const row = rowsToObjects(await turso(
    `SELECT q.id, q.reference, q.ride_id, q.queue_position, q.payment_status, q.queue_status,
        q.created_at, q.accepted_at, q.arrived_at, q.boarded_at, q.completed_at, q.cancelled_at,
        COALESCE(oz.name,'') AS pickup_zone, COALESCE(dz.name,'') AS destination_zone,
        COALESCE(c.name,'') AS corridor_name, COALESCE(c.estimated_minutes,0) AS estimated_minutes,
        COALESCE(r.capacity,0) AS capacity, COALESCE(r.status,'') AS ride_status, COALESCE(r.accepting_queue,0) AS accepting_queue,
        COALESCE(r.current_latitude,0) AS current_latitude, COALESCE(r.current_longitude,0) AS current_longitude,
        COALESCE(r.last_location_at,'') AS last_location_at,
        COALESCE(d.name,'') AS driver_name, COALESCE(v.label,'') AS vehicle_label, COALESCE(v.plate_number,'') AS plate_number,
        COALESCE(dz2.name,'') AS driver_zone, p.status AS payment_status_db, p.access_token_hash
       FROM campus_queue_entries q
       JOIN campus_payments p ON p.queue_entry_id = q.id
       LEFT JOIN campus_rides r ON r.id = q.ride_id
       LEFT JOIN campus_drivers d ON d.id = r.driver_id
       LEFT JOIN campus_vehicles v ON v.id = r.vehicle_id
       LEFT JOIN campus_zones oz ON oz.id = q.pickup_zone_id
       LEFT JOIN campus_zones dz ON dz.id = q.destination_zone_id
       LEFT JOIN campus_zones dz2 ON dz2.id = r.current_zone_id
       LEFT JOIN campus_route_corridors c ON c.id = q.corridor_id
       WHERE p.reference = ? LIMIT 1`,
    [reference],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "campusRide payment was not found.", 404);

  const token = paymentTokenFromRequest(request, reference);
  if (!token || !row.access_token_hash || await hashPaymentToken(token) !== String(row.access_token_hash)) {
    throw new CampusEngineError("FORBIDDEN", "campusRide payment access is not authorised.", 403);
  }

  const status = String(row.queue_status || "").toUpperCase();
  const rideId = String(row.ride_id || "");
  const capacity = Number(row.capacity || 0);
  const tripMinutes = Number(row.estimated_minutes || 0) || 10;
  const active = ACTIVE_STATUSES.has(status);

  let peopleAhead: number | null = null;
  if (active && rideId) {
    const counted = rowsToObjects(await turso(
      `SELECT COUNT(*) AS c FROM campus_queue_entries WHERE ride_id = ? AND queue_position < ? AND queue_status IN (${ACTIVE_SQL})`,
      [rideId, Number(row.queue_position || 0)],
    ))[0];
    peopleAhead = Number(counted?.c || 0);
  }
  // Without a vehicle capacity the batch estimate would be misleading, so the
  // passenger sees "people ahead" only.
  const estimatedWaitMinutes = active && capacity > 0 ? estimateWaitMinutes({ peopleAhead: peopleAhead || 0, capacity, tripMinutes }) : null;
  await incrementMetric("queue_status_check");

  return {
    reference,
    status,
    paymentStatus: String(row.payment_status_db || row.payment_status || ""),
    queuePosition: Number(row.queue_position || 0),
    peopleAhead,
    estimatedWaitMinutes,
    waitLabel: estimatedWaitMinutes === null ? null : waitLabel(estimatedWaitMinutes),
    progress: queueProgress(status),
    route: {
      pickupZone: String(row.pickup_zone || ""),
      destinationZone: String(row.destination_zone || ""),
      corridorName: String(row.corridor_name || ""),
    },
    driver: {
      name: String(row.driver_name || ""),
      vehicleLabel: String(row.vehicle_label || ""),
      plateNumber: String(row.plate_number || ""),
      zoneName: String(row.driver_zone || ""),
      latitude: Number(row.current_latitude || 0) || null,
      longitude: Number(row.current_longitude || 0) || null,
      lastSeenAt: String(row.last_location_at || ""),
    },
    ride: { id: rideId, capacity, status: String(row.ride_status || ""), acceptingQueue: Number(row.accepting_queue) === 1 },
    updatedAt: new Date().toISOString(),
  };
}
