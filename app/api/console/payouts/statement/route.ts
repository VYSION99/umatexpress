import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { organizerStatement } from "@/lib/organizer-payouts";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The organizer's own statement. The id comes from the signed session, so one
 * organizer can never read another's earnings, and there is no query parameter
 * that widens the read.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ORGANIZER"]);
    if (!account.profileId) {
      throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
    }
    return Response.json({ ok: true, statement: await organizerStatement(account.profileId) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
