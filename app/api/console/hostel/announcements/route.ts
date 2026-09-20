import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { createHostelAnnouncement, listHostelAnnouncementsForLandlord } from "@/lib/hostel-engine/messages";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Everything this landlord has published, newest first. */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    return Response.json({ ok: true, announcements: await listHostelAnnouncementsForLandlord(host.landlordId) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-announcement", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { propertyId?: unknown; title?: unknown; body?: unknown };
    const host = await resolveHostelHost(account);
    const announcement = await createHostelAnnouncement({
      landlordId: host.landlordId,
      propertyId: String(body.propertyId || ""),
      authorEmail: account.email,
      authorName: account.name,
      title: body.title,
      body: body.body,
    });
    return Response.json({ ok: true, announcement }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
