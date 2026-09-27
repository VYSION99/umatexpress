import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { cancelStudentViewing, listPublicViewingSlots, requestHostelViewing } from "@/lib/hostel-engine/viewings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent, studentAccountFromRequest } from "@/lib/student-auth";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-viewings-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || "";
    if (!propertyId || propertyId.length > 80) throw new CampusEngineError("VALIDATION_ERROR", "Choose a property.", 400);
    const account = await studentAccountFromRequest(request);
    return Response.json({ ok: true, slots: await listPublicViewingSlots(propertyId, account?.email || "") }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function POST(request: Request) {
  try {
    const account = await requireStudent(request);
    const limited = await rateLimit(request, "hostel-viewings-write", { limit: 15, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: string; slotId?: string; note?: string };
    return Response.json({ ok: true, slots: await requestHostelViewing({ email: account.email, propertyId: body.propertyId || "", slotId: body.slotId || "", note: body.note }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function DELETE(request: Request) {
  try {
    const account = await requireStudent(request);
    const limited = await rateLimit(request, "hostel-viewings-write", { limit: 15, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { requestId?: string };
    return Response.json({ ok: true, request: await cancelStudentViewing(account.email, String(body.requestId || "")) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
