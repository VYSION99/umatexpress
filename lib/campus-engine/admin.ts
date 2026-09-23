import { staffEmailFromRequest } from "@/lib/staff-session";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { campusAudit } from "@/lib/campus-engine/audit";
import { campusFareReport } from "@/lib/campus-engine/fares";
import { getCampusData, upsertCampusCorridor, upsertCampusDriver, upsertCampusVehicle, upsertCampusZone } from "@/lib/campus-ride";
import { resetDriverPasswordByAdmin } from "@/lib/campus-engine/driver-auth";

export async function requireSuperAdmin(request: Request) {
  const email = await staffEmailFromRequest(request);
  if (!email) throw new CampusEngineError("UNAUTHORIZED", "Admin access is not authorised.", 401);
  return { email, role: "SUPER_ADMIN" as const };
}

export async function campusOverview(request: Request) {
  await requireSuperAdmin(request);
  const data = await getCampusData();
  // The fare guardrails ride with the overview rather than on their own route:
  // the person editing a fare is the person who needs to see the floor beside
  // it, and a second round trip would only let the two disagree.
  return { ...data, fareReport: await campusFareReport(data.corridors) };
}

export async function manageCampusResource(request: Request) {
  const actor = await requireSuperAdmin(request);
  const body = await request.json() as { resource?: "zone" | "corridor" | "vehicle" | "driver" | "driverPassword"; payload?: Record<string, unknown> };
  const payload = body.payload || {};
  let item: unknown;
  // What a price replaced is the first question anyone asks afterwards, so the
  // corridor audit carries the old fare and the guardrails the new one was
  // checked against, not just the form that was submitted.
  let details: Record<string, unknown> = payload;
  if (body.resource === "zone") item = await upsertCampusZone(payload);
  else if (body.resource === "corridor") {
    const corridorId = String(payload.id || "").trim();
    const before = corridorId ? (await getCampusData()).corridors.find((corridor) => corridor.id === corridorId) : undefined;
    const saved = await upsertCampusCorridor({ ...payload, actor: actor.email });
    item = saved;
    details = { ...payload, previousFare: before ? before.fare : null, fare: saved?.fare ?? null, floorAmount: saved?.floorAmount ?? null, ceilingAmount: saved?.ceilingAmount ?? null, belowFloorAcknowledged: Boolean(saved && saved.fare < saved.floorAmount) };
  }
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
  await campusAudit({ actorType:"admin", actorId:actor.email, action, targetType:body.resource || "resource", targetReference, details: body.resource === "driverPassword" ? { driverId: payload.driverId } : details });
  return { resource: body.resource, item };
}
