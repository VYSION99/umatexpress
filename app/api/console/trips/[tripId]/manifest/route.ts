import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getOrganizerManifest } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Passenger contacts for one trip (decision D3).
 *
 * The trip id comes from the path, but the owner does not: for an organizer it
 * is always the session's profile id, and `getOrganizerManifest` puts it in the
 * WHERE clause so another organizer's trip reads as missing rather than
 * forbidden — an id cannot be probed. Every read writes an audit row.
 *
 * Staff may read a manifest too, and must name the organizer whose trip it is,
 * so the audit row always records who was acting and for whom.
 */
export async function GET(request: Request, context: { params: Promise<{ tripId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["ORGANIZER", "ADMIN", "MODERATOR"]);
    const { tripId } = await context.params;
    const cleanTripId = String(tripId || "").trim();
    if (!cleanTripId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a trip.", 400);

    const organizerId = account.role === "ORGANIZER"
      ? account.profileId
      : String(new URL(request.url).searchParams.get("organizerId") || "").trim();
    if (!organizerId) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose the organizer whose trip this is.", 400);
    }

    const manifest = await getOrganizerManifest({ organizerId, tripId: cleanTripId, actor: account.email });
    return Response.json({ ok: true, ...manifest }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
