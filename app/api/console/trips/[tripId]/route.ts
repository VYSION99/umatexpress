import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { archiveOrganizerTrip, updateOrganizerTrip } from "@/lib/organizer-trips";

const NO_STORE = { "Cache-Control": "no-store" };

async function ownerFromSession(request: Request) {
  const account = await requireConsoleRole(request, ["ORGANIZER"]);
  if (!account.profileId) {
    throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
  }
  return account.profileId;
}

/**
 * Edits one of the organizer's own trips. The update is scoped by the session's
 * organizer id inside the statement, so another organizer's trip id reports as
 * missing rather than forbidden. An edit to a live trip returns it to review.
 */
export async function PATCH(request: Request, context: { params: Promise<{ tripId: string }> }) {
  try {
    const organizerId = await ownerFromSession(request);
    const { tripId } = await context.params;
    const trip = await updateOrganizerTrip(organizerId, String(tripId || ""), await request.json() as Record<string, unknown>);
    return Response.json({ ok: true, trip }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/** Removes a trip the organizer owns, as long as it is not live. */
export async function DELETE(request: Request, context: { params: Promise<{ tripId: string }> }) {
  try {
    const organizerId = await ownerFromSession(request);
    const { tripId } = await context.params;
    return Response.json({ ok: true, ...await archiveOrganizerTrip(organizerId, String(tripId || "")) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
