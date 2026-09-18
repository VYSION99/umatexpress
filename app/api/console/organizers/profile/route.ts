import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getOrganizerProfile } from "@/lib/organizers";
import { listPayoutDestinations } from "@/lib/paystack-banks";

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
    // The payout form has to offer somewhere to send the money, so the banks
    // and networks come back with the profile rather than from a second call.
    const [profile, banks, networks] = await Promise.all([
      getOrganizerProfile(account.profileId),
      listPayoutDestinations("BANK"),
      listPayoutDestinations("MOMO"),
    ]);
    return Response.json({ ok: true, profile, destinations: { BANK: banks, MOMO: networks } }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
