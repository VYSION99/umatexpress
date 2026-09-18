import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { saveOrganizerPayoutAccount } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Capturing payout details is not the same as being able to receive money:
 * KYC verification and the Phase 4 ledger are separate gates, and the response
 * stays masked either way.
 */
export async function PUT(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ORGANIZER"]);
    if (!account.profileId) {
      throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
    }
    const body = await request.json() as { method?: string; accountName?: string; accountNumber?: string };
    return Response.json({ ok: true, profile: await saveOrganizerPayoutAccount(account.profileId, body) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
