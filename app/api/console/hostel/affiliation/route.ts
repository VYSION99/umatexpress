import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assertHostelOwner, resolveHostelHost } from "@/lib/hostel-engine/managers";
import { propertyAffiliation, savePropertyAffiliation } from "@/lib/hostel-engine/onboarding";
const NO_STORE = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || "";
    const host = await resolveHostelHost(account);
    // An owner-scoped property read establishes authorization before returning affiliation.
    const { getHostelProperty } = await import("@/lib/hostel-engine/landlord");
    await getHostelProperty(host.landlordId, propertyId);
    return Response.json({ ok: true, affiliation: await propertyAffiliation(propertyId) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const body = await request.json() as { propertyId?: string; claim?: string; evidenceNote?: string };
    return Response.json({ ok: true, affiliation: await savePropertyAffiliation({ landlordId: host.landlordId, propertyId: body.propertyId || "", claim: body.claim || "", evidenceNote: body.evidenceNote || "", actor: account.email }) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
