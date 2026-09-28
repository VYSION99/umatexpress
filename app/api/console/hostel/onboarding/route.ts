import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost, assertHostelOwner } from "@/lib/hostel-engine/managers";
import { ownerReadiness, updateOwnerProfile } from "@/lib/hostel-engine/onboarding";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const NO_STORE = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const host = await resolveHostelHost(account);
    return Response.json({ ok: true, owner: await ownerReadiness(host.landlordId) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-onboarding-profile", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const body = await request.json() as { ownerRole?: string; organization?: string };
    return Response.json({ ok: true, owner: await updateOwnerProfile({ landlordId: host.landlordId, ownerRole: body.ownerRole || "", organization: body.organization || "", actor: account.email }) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
