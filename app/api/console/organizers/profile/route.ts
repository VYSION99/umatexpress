import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getOrganizerProfile } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The organizer's own KYC and payout record. Account numbers are masked here
 * and there is no query parameter that widens it, so this response is safe to
 * render anywhere in the console.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ORGANIZER"]);
    if (!account.profileId) {
      throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
    }
    return Response.json({ ok: true, profile: await getOrganizerProfile(account.profileId) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
