import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { organizerInsights, organizerTripPerformance } from "@/lib/organizer-insights";
import { organizerStatement, payoutReleaseMinutes, payoutTransferFee } from "@/lib/organizer-payouts";

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
    // The statement answers "what am I owed"; the insights answer "which trips
    // earned it". They read the same ledger, so the numbers agree by
    // construction rather than by being computed twice.
    const [statement, insights, trips, transferFee, releaseMinutes] = await Promise.all([
      organizerStatement(account.profileId),
      organizerInsights(account.profileId),
      organizerTripPerformance(account.profileId),
      // What a payout will cost them, so the statement can say it rather than
      // leaving the fee to be discovered in the difference between the two
      // amounts on a batch row.
      payoutTransferFee("MOMO"),
      payoutReleaseMinutes(),
    ]);
    return Response.json({ ok: true, statement, insights, trips, transferFee, releaseMinutes }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
