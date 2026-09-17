import { requireDriver } from "@/lib/campus-engine/driver-auth";
import { ensureCampusRideTables } from "@/lib/campus-ride";
import { utcDay } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

const ACTIVE_SQL = "'PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED'";

/** Today's earnings and workload for the signed-in driver. */
export async function driverSummary(request: Request) {
  const driver = await requireDriver(request);
  const day = utcDay();
  const empty = { configured: false, day, completed: 0, boarded: 0, grossFares: 0, activeQueue: 0, nextPickup: null as null | { reference: string; queuePosition: number; passengerName: string; pickupZone: string } };
  if (!(await isTursoConfiguredRuntime())) return empty;
  await ensureCampusRideTables();

  const totals = rowsToObjects(await turso(
    `SELECT
      COALESCE(SUM(CASE WHEN q.queue_status = 'COMPLETED' AND q.completed_at >= ? THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN q.queue_status = 'BOARDED' AND q.boarded_at >= ? THEN 1 ELSE 0 END), 0) AS boarded,
      COALESCE(SUM(CASE WHEN q.queue_status = 'COMPLETED' AND q.completed_at >= ? THEN q.amount ELSE 0 END), 0) AS gross,
      COALESCE(SUM(CASE WHEN q.queue_status IN (${ACTIVE_SQL}) THEN 1 ELSE 0 END), 0) AS active
     FROM campus_queue_entries q
     JOIN campus_rides r ON r.id = q.ride_id
     WHERE r.driver_id = ?`,
    [`${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`, driver.id],
  ))[0];

  const next = rowsToObjects(await turso(
    `SELECT q.reference, q.queue_position, q.passenger_name, COALESCE(z.name, '') AS pickup_zone
     FROM campus_queue_entries q
     JOIN campus_rides r ON r.id = q.ride_id
     LEFT JOIN campus_zones z ON z.id = q.pickup_zone_id
     WHERE r.driver_id = ? AND q.queue_status IN (${ACTIVE_SQL})
     ORDER BY q.queue_position ASC, q.created_at ASC LIMIT 1`,
    [driver.id],
  ))[0];

  return {
    configured: true,
    day,
    completed: Number(totals?.completed || 0),
    boarded: Number(totals?.boarded || 0),
    grossFares: Number(totals?.gross || 0),
    activeQueue: Number(totals?.active || 0),
    nextPickup: next ? {
      reference: String(next.reference || ""),
      queuePosition: Number(next.queue_position || 0),
      passengerName: String(next.passenger_name || ""),
      pickupZone: String(next.pickup_zone || ""),
    } : null,
  };
}
