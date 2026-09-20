import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { updateHostelSpace } from "@/lib/hostel-engine/landlord";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Rename a bed, or retire/restore it without changing the room's capacity. */
export async function PATCH(request: Request, context: { params: Promise<{ spaceId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { spaceId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const space = await updateHostelSpace((await resolveHostelHost(account)).landlordId, String(spaceId || ""), body);
    return Response.json({ ok: true, space }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
