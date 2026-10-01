import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { hostelStayDetail, updateHostelStay, type StayAction } from "@/lib/hostel-engine/stays";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const host = await resolveHostelHost(await requireConsoleRole(request, ["LANDLORD"]));
    const limited = await rateLimit(request, "hostel-stay-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    return Response.json({ ok: true, ...await hostelStayDetail(host.landlordId, url.searchParams.get("reference") || "", url.searchParams.get("q") || "") }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const host = await resolveHostelHost(await requireConsoleRole(request, ["LANDLORD"]));
    const limited = await rateLimit(request, "hostel-stay-write", { limit: 90, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const detail = await updateHostelStay({ landlordId: host.landlordId, actor: host.email, reference: String(body.reference || ""),
      action: String(body.action || "") as StayAction, version: Number(body.version), expectedArrivalOn: String(body.expectedArrivalOn || ""),
      keyReference: String(body.keyReference || ""), keysReturned: body.keysReturned === true, note: String(body.note || ""), targetListingId: String(body.targetListingId || "") });
    return Response.json({ ok: true, ...detail }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
