import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { hostelResidentList } from "@/lib/hostel-engine/resident-list";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The console's resident list: every booking for this landlord, each row
 * carrying its unread count and how many services are open, plus the totals a
 * dashboard strip needs. A delegate manager sees exactly what the owner sees,
 * because both resolve to the same landlord id.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const url = new URL(request.url);
    const data = await hostelResidentList(host.landlordId, {
      propertyId: url.searchParams.get("propertyId") || "", periodId: url.searchParams.get("periodId") || "",
      search: url.searchParams.get("q") || "", status: url.searchParams.get("status") || "", page: Number(url.searchParams.get("page") || 1),
    });
    return Response.json({ ok: true, ...data, isOwner: host.isOwner }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
