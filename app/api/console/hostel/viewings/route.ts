import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { createHostelViewingSlot, listLandlordViewings, manageHostelViewing } from "@/lib/hostel-engine/viewings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || "";
    return Response.json({ ok: true, ...await listLandlordViewings((await resolveHostelHost(account)).landlordId, propertyId) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-viewings-manage", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: string; startsAt?: string; endsAt?: string; capacity?: number };
    return Response.json({ ok: true, ...await createHostelViewingSlot({ landlordId: (await resolveHostelHost(account)).landlordId, propertyId: body.propertyId || "", startsAt: body.startsAt, endsAt: body.endsAt, capacity: body.capacity, actor: account.email }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-viewings-manage", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: string; action?: string; slotId?: string; requestId?: string };
    return Response.json({ ok: true, ...await manageHostelViewing({ landlordId: (await resolveHostelHost(account)).landlordId, propertyId: body.propertyId || "", action: body.action || "", slotId: body.slotId, requestId: body.requestId, actor: account.email }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
