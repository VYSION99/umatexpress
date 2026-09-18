import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listTripsAwaitingReview } from "@/lib/organizer-trips";

const NO_STORE = { "Cache-Control": "no-store" };

/** The trip review queue. Admins and moderators both decide. */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    return Response.json({ trips: await listTripsAwaitingReview() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
