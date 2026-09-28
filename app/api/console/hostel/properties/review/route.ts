import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assertHostelOwner, resolveHostelHost } from "@/lib/hostel-engine/managers";
import { reviewProperty, submitPropertyForReview } from "@/lib/hostel-engine/onboarding";
const NO_STORE = { "Cache-Control": "no-store" };
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as { propertyId?: string; action?: string; reason?: string };
    if (!body.propertyId || !["APPROVE", "REJECT"].includes(body.action || "")) throw new CampusEngineError("VALIDATION_ERROR", "Choose a property and decision.", 400);
    return Response.json({ ok: true, result: await reviewProperty({ propertyId: body.propertyId, action: body.action as "APPROVE" | "REJECT", reason: body.reason, actor: account.email }) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const body = await request.json() as { propertyId?: string };
    if (!body.propertyId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a property.", 400);
    return Response.json({ ok: true, result: await submitPropertyForReview({ landlordId: host.landlordId, propertyId: body.propertyId, actor: account.email }) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
