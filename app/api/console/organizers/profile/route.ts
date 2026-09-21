import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getOrganizerProfile, ORGANIZER_PAYOUT_METHODS } from "@/lib/organizers";
import { payoutTransferFee } from "@/lib/organizer-payouts";
import { getPaystackFeePercentRuntime } from "@/lib/paystack";
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
    // The payout form has to offer somewhere to send the money, so the networks
    // come back with the profile rather than from a second call. Only mobile
    // money is offered: rides do not pay out to a bank account.
    const [profile, networks, transferFee, checkoutPercent] = await Promise.all([
      getOrganizerProfile(account.profileId),
      listPayoutDestinations("MOMO"),
      payoutTransferFee("MOMO"),
      getPaystackFeePercentRuntime(),
    ]);
    return Response.json({
      ok: true,
      profile,
      destinations: { MOMO: networks },
      // The charges are read from the same settings the release job uses, so
      // what an organizer is told is what the payout actually does.
      payoutMethods: ORGANIZER_PAYOUT_METHODS,
      fees: { transferFee, checkoutPercent },
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
