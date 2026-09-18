import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { reviewOrganizerTrip } from "@/lib/organizer-trips";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One endpoint for the whole trip decision, so the state machine has a single
 * definition. An organizer may only `SUBMIT` their own trip; `APPROVE` and
 * `REJECT` belong to a reviewer, and pulling a live trip (`SUSPEND`) is an
 * admin action, since it takes something down that students can currently buy.
 */
export async function PATCH(request: Request, context: { params: Promise<{ tripId: string }> }) {
  try {
    const body = await request.json() as { action?: string; reason?: string };
    const action = String(body.action || "").trim().toUpperCase();
    const { tripId } = await context.params;

    const roles = action === "SUBMIT"
      ? (["ORGANIZER"] as const)
      : action === "SUSPEND"
        ? (["ADMIN"] as const)
        : (["ADMIN", "MODERATOR"] as const);
    if (!["SUBMIT", "APPROVE", "REJECT", "SUSPEND"].includes(action)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose submit, approve, reject or suspend.", 400);
    }

    const account = await requireConsoleRole(request, roles);
    const trip = await reviewOrganizerTrip({
      tripId: String(tripId || ""),
      action: action as "SUBMIT" | "APPROVE" | "REJECT" | "SUSPEND",
      reason: body.reason,
      actor: account.email,
      organizerId: account.role === "ORGANIZER" ? account.profileId : undefined,
    });
    return Response.json({ ok: true, trip }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
