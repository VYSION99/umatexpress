import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { saveOrganizerKyc } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * KYC is captured as an ID type and number only. No file storage is bound to
 * this Worker, so there is nowhere for a scan to go, and identity documents
 * need a retention policy before they are kept.
 */
export async function PUT(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ORGANIZER"]);
    if (!account.profileId) {
      throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
    }
    const body = await request.json() as { idType?: string; idNumber?: string };
    return Response.json({ ok: true, profile: await saveOrganizerKyc(account.profileId, body) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
