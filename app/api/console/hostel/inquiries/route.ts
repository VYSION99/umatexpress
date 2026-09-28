import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listHostelAiInquiries, replyHostelAiInquiry } from "@/lib/hostel-engine/ai-desk";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || "";
    return Response.json({ ok: true, inquiries: await listHostelAiInquiries((await resolveHostelHost(account)).landlordId, propertyId) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-ai-reply", { limit: 50, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: string; id?: string; reply?: string };
    return Response.json({ ok: true, inquiries: await replyHostelAiInquiry({ landlordId: (await resolveHostelHost(account)).landlordId, propertyId: body.propertyId || "", id: body.id || "", reply: body.reply, actor: account.email }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
