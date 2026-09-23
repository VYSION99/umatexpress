import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { isDriverDecision, listDriverApplications, reviewDriverApplication } from "@/lib/campus-engine/driver-onboarding";
import { requireConsoleRole } from "@/lib/console-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Driver applications, decided in the console.
 *
 * Only an administrator decides these, matching the campus operations console
 * that owns drivers, vehicles and zones: approving a driver is the same kind of
 * act as putting them in a vehicle, and both belong to one role.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    return Response.json({ ok: true, drivers: await listDriverApplications() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { driverId?: string; action?: string; reason?: string };
    const action = String(body.action || "").trim().toUpperCase();
    if (!isDriverDecision(action)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose approve, reject or suspend.", 400);
    }
    const driver = await reviewDriverApplication({
      driverId: String(body.driverId || "").trim(),
      action,
      reason: body.reason,
      actor: account.email,
    });
    return Response.json({ ok: true, driver }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
