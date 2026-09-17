import { adminEmailFromRequest } from "@/lib/admin-auth";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { campusAudit } from "@/lib/campus-engine/audit";
import { getCampusData, upsertCampusCorridor, upsertCampusDriver, upsertCampusVehicle, upsertCampusZone } from "@/lib/campus-ride";
import { resetDriverPasswordByAdmin } from "@/lib/campus-engine/driver-auth";

export async function requireSuperAdmin(request: Request) {
  const email = await adminEmailFromRequest(request);
  if (!email) throw new CampusEngineError("UNAUTHORIZED", "Admin access is not authorised.", 401);
  return { email, role: "SUPER_ADMIN" as const };
}

export async function campusOverview(request: Request) {
  await requireSuperAdmin(request);
  return getCampusData();
}

export async function manageCampusResource(request: Request) {
  const actor = await requireSuperAdmin(request);
  const body = await request.json() as { resource?: "zone" | "corridor" | "vehicle" | "driver" | "driverPassword"; payload?: Record<string, unknown> };
  const payload = body.payload || {};
  let item: unknown;
  if (body.resource === "zone") item = await upsertCampusZone(payload);
  else if (body.resource === "corridor") item = await upsertCampusCorridor(payload);
  else if (body.resource === "vehicle") item = await upsertCampusVehicle(payload);
  else if (body.resource === "driver") item = await upsertCampusDriver(payload);
  else if (body.resource === "driverPassword") {
    const driverId = String(payload.driverId || "").trim();
    if (!driverId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a driver to reset.", 400);
    item = await resetDriverPasswordByAdmin(driverId);
  }
  else throw new CampusEngineError("VALIDATION_ERROR", "Unknown campusRide resource.", 400);
  const targetReference = String((item as { id?: string; driverId?: string } | undefined)?.id || (item as { driverId?: string } | undefined)?.driverId || "");
  const action = body.resource === "driverPassword" ? "RESET_DRIVER_PASSWORD" : `UPSERT_${body.resource?.toUpperCase()}`;
  await campusAudit({ actorType:"admin", actorId:actor.email, action, targetType:body.resource || "resource", targetReference, details: body.resource === "driverPassword" ? { driverId: payload.driverId } : payload });
  return { resource: body.resource, item };
}
