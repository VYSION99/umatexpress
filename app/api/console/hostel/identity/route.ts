import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assertHostelOwner, resolveHostelHost } from "@/lib/hostel-engine/managers";
import { identityDocuments, MAX_IDENTITY_BYTES, uploadIdentityDocument } from "@/lib/hostel-engine/onboarding";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const NO_STORE = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const host = await resolveHostelHost(account);
    return Response.json({ ok: true, documents: await identityDocuments(host.landlordId) }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-identity-upload", { limit: 12, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size > MAX_IDENTITY_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Choose a document under 6 MB.", 400);
    const document = await uploadIdentityDocument({ landlordId: host.landlordId, kind: String(form.get("kind") || ""), file, actor: account.email });
    return Response.json({ ok: true, document }, { status: 201, headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
