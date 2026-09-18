import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assignTripToOrganizer, listOrganizerTrips } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The signed-in organizer's own trips. Ownership is `account.profileId`, which
 * comes from the signed session — a `?organizerId=` in the query string is
 * ignored, so one organizer cannot read another's list.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ORGANIZER"]);
    if (!account.profileId) {
      throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
    }
    return Response.json({ trips: await listOrganizerTrips(account.profileId) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/**
 * Assigns an existing trip to an organizer. Admin only: Phase 2 has no
 * organizer-created trips, so this is how ownership is established. A moderator
 * may approve people but may not move trips between them.
 */
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { tripId?: string; organizerId?: string };
    const result = await assignTripToOrganizer({
      tripId: String(body.tripId || ""),
      organizerId: String(body.organizerId || ""),
      actor: account.email,
    });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
