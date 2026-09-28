import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { archiveHostelAiEntry, listHostelAiEntries, saveHostelAiEntry } from "@/lib/hostel-engine/ai-desk";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || "";
    return Response.json({ ok: true, entries: await listHostelAiEntries((await resolveHostelHost(account)).landlordId, propertyId) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-ai-info", { limit: 50, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: string; id?: string; roomId?: string; title?: string; content?: string };
    return Response.json({ ok: true, entries: await saveHostelAiEntry({ landlordId: (await resolveHostelHost(account)).landlordId, propertyId: body.propertyId || "", id: body.id, roomId: body.roomId, title: body.title, content: body.content, actor: account.email }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
export async function DELETE(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const body = await request.json() as { propertyId?: string; id?: string };
    return Response.json({ ok: true, entries: await archiveHostelAiEntry({ landlordId: (await resolveHostelHost(account)).landlordId, propertyId: body.propertyId || "", id: body.id || "", actor: account.email }) }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
