import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listHostelVerificationWorkspace, recordHostelVerification } from "@/lib/hostel-engine/verification";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return Response.json({ ok: true, ...await listHostelVerificationWorkspace() }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-verification-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: string; kind?: string; action?: string; note?: string };
    return Response.json({ ok: true, record: await recordHostelVerification({ propertyId: body.propertyId || "", kind: body.kind || "", action: body.action || "", note: body.note || "", actor: account.email }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
