import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { retryFailedPayouts, runPayoutReconcileJob, runPayoutReleaseJob } from "@/lib/organizer-payouts";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Running the payout job by hand.
 *
 * The unattended cron is behind `PAYOUT_AUTO_ENABLED`, because a schedule that
 * moves money should be something a deployment opts into. A person pressing a
 * button is a different act: this path runs without the switch and is audited
 * as the administrator who pressed it.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json().catch(() => ({})) as { action?: string; organizerId?: string };
    const action = String(body.action || "RELEASE").trim().toUpperCase();
    if (action === "RETRY") {
      const result = await retryFailedPayouts({ organizerId: String(body.organizerId || ""), actor: account.email });
      return Response.json({ ok: true, action, ...result }, { headers: NO_STORE });
    }
    if (action === "RECONCILE") {
      return Response.json({ ok: true, action, result: await runPayoutReconcileJob({ limit: 4 }) }, { headers: NO_STORE });
    }
    if (action !== "RELEASE") {
      throw new CampusEngineError("VALIDATION_ERROR", "Unknown payout action.", 400);
    }
    // Six: a manual run is attended, and each candidate spends roughly six
    // subrequests of the invocation's fifty.
    const result = await runPayoutReleaseJob({ limit: 6, actor: account.email });
    return Response.json({ ok: true, action, result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
