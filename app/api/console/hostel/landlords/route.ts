import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { isHostelKycAction, listHostelLandlordsForStaff, reviewHostelLandlordKyc } from "@/lib/hostel-engine/landlord";

const NO_STORE = { "Cache-Control": "no-store" };
const KYC_ACTIONS: Record<string, "VERIFY" | "REJECT"> = { VERIFY_KYC: "VERIFY", REJECT_KYC: "REJECT" };

/**
 * The landlord verification queue. Staff read who is waiting and how to reach
 * them; deciding KYC only opens the money gate, so it changes nothing about
 * what a landlord may build or list.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    return Response.json({ ok: true, landlords: await listHostelLandlordsForStaff() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as { landlordId?: string; action?: string; reason?: string };
    const landlordId = String(body.landlordId || "").trim();
    if (!landlordId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord to review.", 400);
    const action = KYC_ACTIONS[String(body.action || "").trim().toUpperCase()];
    if (!isHostelKycAction(action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose verify KYC or reject KYC.", 400);
    const landlord = await reviewHostelLandlordKyc({ landlordId, action, reason: body.reason, actor: account.email });
    return Response.json({ ok: true, landlord }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
