import { ensureCampusRideTables, getCampusData, type CampusQueueEntry } from "@/lib/campus-ride";
import { campusAudit } from "@/lib/campus-engine/audit";
import { requireDriver } from "@/lib/campus-engine/driver-auth";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { mapQueueEntry } from "@/lib/campus-engine/rides";
import { applyCampusQueueTransition, releaseCampusSlots } from "@/lib/campus-engine/queue";
import { CAMPUS_NOTIFY_BY_STATUS, CAMPUS_NOTIFY_SUBJECTS, campusNotification } from "@/lib/campus-engine/notify-templates";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

const activeQueueStatuses = ["PAID_WAITING", "ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED", "BOARDED"];

function requirePermanentDriverPassword(driver: { mustChangePassword?: boolean }) {
  if (driver.mustChangePassword) {
    throw new CampusEngineError("PASSWORD_CHANGE_REQUIRED", "Change your temporary driver password before operating live rides.", 403);
  }
}

/**
 * Best-effort passenger notification for a queue transition. Messages are
 * queued here and delivered by the reconciliation cron, so a notification
 * problem can never undo or delay a driver action. The row doubles as the
 * student's in-app notification, which is why it is queued even when no mail
 * provider is configured.
 */
async function queuePassengerNotification(row: Record<string, unknown>, driverName: string, status: string) {
  const template = CAMPUS_NOTIFY_BY_STATUS[status];
  const reference = String(row.reference || "");
  // The account address the passenger booked with, not the phone on the entry:
  // mail is the delivery channel now.
  const recipient = String(row.email || "");
  if (!template || !reference || !recipient) return;
  try {
    const notification = campusNotification(template, { driverName, queuePosition: Number(row.queue_position || 0) });
    const queued = await queueNotification(turso, {
      recipient,
      template,
      subject: CAMPUS_NOTIFY_SUBJECTS[template],
      message: notification.message,
      reference,
      nowIso: new Date().toISOString(),
    });
    if (queued) await incrementMetric("notification_queued");
  } catch {
    // Notifications are a comfort layer, not part of the ride invariant.
  }
}

type CampusDriverSession = Awaited<ReturnType<typeof requireDriver>>;

async function driverMeFor(driver: CampusDriverSession) {
  const data = await getCampusData();
  const ride = data.rides.find((item) => item.driverId === driver.id && ["OPEN", "PAUSED", "FULL"].includes(item.status));
  return { driver, ride, zones: data.zones, corridors: data.corridors, vehicles: data.vehicles };
}

export async function driverMe(request: Request) {
  return driverMeFor(await requireDriver(request));
}

async function driverQueueFor(driver: CampusDriverSession) {
  if (!(await isTursoConfiguredRuntime())) return { queue: [] as CampusQueueEntry[], preview: true };
  await ensureCampusRideTables();
  const queue = rowsToObjects(await turso(
    `SELECT q.*, oz.name AS pickup_zone, dz.name AS destination_zone
     FROM campus_queue_entries q
     JOIN campus_rides r ON r.id = q.ride_id
     LEFT JOIN campus_zones oz ON oz.id = q.pickup_zone_id
     LEFT JOIN campus_zones dz ON dz.id = q.destination_zone_id
     WHERE r.driver_id = ? AND q.queue_status IN ('PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED')
     ORDER BY q.queue_position ASC, q.created_at ASC`,
    [driver.id],
  )).map((row) => {
    const entry = mapQueueEntry(row);
    // The boarding PIN is proof the passenger is present; drivers must not read it.
    delete entry.ridePin;
    return entry;
  });
  return { queue };
}

export async function driverQueue(request: Request) {
  return driverQueueFor(await requireDriver(request));
}

export async function updateDriverQueueEntry(request: Request, input: { reference?: string; action?: string; pin?: string }) {
  const driver = await requireDriver(request);
  requirePermanentDriverPassword(driver);
  const reference = String(input.reference || "").trim();
  const action = String(input.action || "").trim();
  const pin = String(input.pin || "").trim();
  if (!reference || !action) throw new CampusEngineError("VALIDATION_ERROR", "Queue reference and action are required.", 400);
  if (!(await isTursoConfiguredRuntime())) return { ok: true, preview: true };
  await ensureCampusRideTables();
  const row = rowsToObjects(await turso(
    `SELECT q.*, r.driver_id
     FROM campus_queue_entries q
     JOIN campus_rides r ON r.id = q.ride_id
     WHERE q.reference = ? AND r.driver_id = ?
     LIMIT 1`,
    [reference, driver.id],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "Passenger queue entry was not found for this driver.", 404);

  const current = String(row.queue_status || "");
  const stamp = new Date().toISOString();
  let next = "";
  let timeColumn = "";
  let releaseSeat = false;

  if (action === "accept") {
    if (current !== "PAID_WAITING") throw new CampusEngineError("INVALID_STATE", "Only paid waiting passengers can be accepted.", 409);
    next = "ACCEPTED_BY_DRIVER";
    timeColumn = "accepted_at";
  } else if (action === "arrived") {
    if (current !== "ACCEPTED_BY_DRIVER") throw new CampusEngineError("INVALID_STATE", "Accept the passenger before marking arrived.", 409);
    next = "DRIVER_ARRIVED";
    timeColumn = "arrived_at";
  } else if (action === "verify-pin") {
    if (current !== "DRIVER_ARRIVED") throw new CampusEngineError("INVALID_STATE", "Mark arrived before verifying the passenger PIN.", 409);
    const lock = await authGuardStatus("driver-pin", reference);
    if (lock.locked) throw new CampusEngineError("FORBIDDEN", `Too many incorrect PIN attempts. Try again in ${lock.retryAfter} seconds.`, 429);
    if (!pin || pin !== String(row.ride_pin || "")) {
      await authGuardFailure("driver-pin", reference);
      throw new CampusEngineError("FORBIDDEN", "Passenger PIN is incorrect.", 403);
    }
    await authGuardClear("driver-pin", reference);
    next = "BOARDED";
    timeColumn = "boarded_at";
  } else if (action === "complete") {
    if (current !== "BOARDED") throw new CampusEngineError("INVALID_STATE", "Only boarded passengers can be completed.", 409);
    next = "COMPLETED";
    timeColumn = "completed_at";
  } else if (action === "no-show") {
    if (!["ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED"].includes(current)) throw new CampusEngineError("INVALID_STATE", "Only accepted or arrived passengers can be marked no-show.", 409);
    next = "NO_SHOW";
    timeColumn = "cancelled_at";
    releaseSeat = true;
  } else if (action === "cancel") {
    if (!activeQueueStatuses.includes(current)) throw new CampusEngineError("INVALID_STATE", "This passenger can no longer be cancelled by the driver.", 409);
    next = "CANCELLED_BY_DRIVER";
    timeColumn = "cancelled_at";
    releaseSeat = true;
  } else {
    throw new CampusEngineError("VALIDATION_ERROR", "Unsupported queue action.", 400);
  }

  const applied = await applyCampusQueueTransition(turso, { entryId: String(row.id), from: current, to: next, timeColumn, nowIso: stamp });
  if (!applied) throw new CampusEngineError("INVALID_STATE", "This passenger's queue status just changed. Refresh and try again.", 409);
  if (releaseSeat) {
    await releaseCampusSlots(turso, { rideId: String(row.ride_id), count: 1, nowIso: stamp });
  }
  await campusAudit({ actorType:"driver", actorId:driver.id, action:`QUEUE_${action.toUpperCase().replace(/-/g, "_")}`, targetType:"campus_queue_entry", targetReference:reference, details:{ from:current, to:next } });
  await queuePassengerNotification(row, driver.name, next);
  return { ...(await driverMeFor(driver)), ...(await driverQueueFor(driver)) };
}

export async function updateDriverLocation(request: Request, input: { currentZoneId?: string; latitude?: number; longitude?: number }) {
  const driver = await requireDriver(request);
  const currentZoneId = String(input.currentZoneId || "").trim();
  if (!currentZoneId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the driver's current zone.", 400);
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const hasGps = Number.isFinite(latitude) && Number.isFinite(longitude);
  if (!(await isTursoConfiguredRuntime())) return { driver: { ...driver, currentZoneId, currentLatitude: hasGps ? latitude : driver.currentLatitude, currentLongitude: hasGps ? longitude : driver.currentLongitude, lastSeenAt: new Date().toISOString() }, preview: true };
  await ensureCampusRideTables();
  const stamp = new Date().toISOString();
  await turso("UPDATE campus_drivers SET current_zone_id = ?, current_latitude = ?, current_longitude = ?, last_seen_at = ?, updated_at = ? WHERE id = ?", [currentZoneId, hasGps ? latitude : "", hasGps ? longitude : "", stamp, stamp, driver.id]);
  await turso("UPDATE campus_rides SET current_zone_id = ?, current_latitude = ?, current_longitude = ?, last_location_at = ?, updated_at = ? WHERE driver_id = ? AND status IN ('OPEN','PAUSED','FULL')", [currentZoneId, hasGps ? latitude : "", hasGps ? longitude : "", stamp, stamp, driver.id]);
  await campusAudit({ actorType:"driver", actorId:driver.id, action:"UPDATE_LOCATION", targetType:"driver", targetReference:driver.id, details:{ currentZoneId, gps:hasGps } });
  return driverMe(request);
}

export async function openDriverRide(request: Request, input: { corridorId?: string; currentZoneId?: string; capacity?: number }) {
  const driver = await requireDriver(request);
  requirePermanentDriverPassword(driver);
  const data = await getCampusData();
  const corridorId = String(input.corridorId || "").trim();
  const corridor = data.corridors.find((item) => item.id === corridorId);
  if (!corridor) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid campusRide corridor.", 400);
  const vehicle = data.vehicles.find((item) => item.id === driver.vehicleId);
  const currentZoneId = String(input.currentZoneId || driver.currentZoneId || corridor.originZoneId).trim();
  const capacity = Math.max(1, Math.round(Number(input.capacity || vehicle?.capacity || 4)));
  if (!(await isTursoConfiguredRuntime())) return { ride: { id:"preview-ride", driverId:driver.id, vehicleId:vehicle?.id || "", corridorId, currentZoneId, status:"OPEN", capacity, availableSlots:capacity, acceptingQueue:true, lastLocationAt:new Date().toISOString(), driverName:driver.name, vehicleLabel:vehicle?.label || "Preview vehicle", plateNumber:vehicle?.plateNumber || "" }, preview:true };
  await ensureCampusRideTables();
  const stamp = new Date().toISOString();
  await turso("UPDATE campus_rides SET status = 'COMPLETED', accepting_queue = 0, ended_at = ?, updated_at = ? WHERE driver_id = ? AND status IN ('OPEN','PAUSED','FULL')", [stamp, stamp, driver.id]);
  const id = crypto.randomUUID();
  await turso("INSERT INTO campus_rides (id,driver_id,vehicle_id,corridor_id,current_zone_id,status,capacity,available_slots,accepting_queue,last_location_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [id, driver.id, vehicle?.id || "", corridorId, currentZoneId, "OPEN", capacity, capacity, 1, stamp, stamp, stamp]);
  await campusAudit({ actorType:"driver", actorId:driver.id, action:"OPEN_RIDE", targetType:"campus_ride", targetReference:id, details:{ corridorId, currentZoneId, capacity } });
  return driverMe(request);
}

export async function updateDriverRide(request: Request, input: { rideId?: string; action?: "pause" | "resume" | "end" }) {
  const driver = await requireDriver(request);
  requirePermanentDriverPassword(driver);
  const rideId = String(input.rideId || "").trim();
  const action = input.action;
  if (!rideId || !action) throw new CampusEngineError("VALIDATION_ERROR", "Ride id and action are required.", 400);
  const status = action === "pause" ? "PAUSED" : action === "resume" ? "OPEN" : "COMPLETED";
  if (!(await isTursoConfiguredRuntime())) return { ok: true, preview: true };
  const stamp = new Date().toISOString();
  await turso("UPDATE campus_rides SET status = ?, accepting_queue = ?, ended_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE ended_at END, updated_at = ? WHERE id = ? AND driver_id = ?", [status, status === "OPEN" ? 1 : 0, status, stamp, stamp, rideId, driver.id]);
  await campusAudit({ actorType:"driver", actorId:driver.id, action:`RIDE_${action.toUpperCase()}`, targetType:"campus_ride", targetReference:rideId });
  return driverMe(request);
}
