import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { createHostelRoom, landlordIdFromAccount } from "@/lib/hostel-engine/landlord";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A room belongs to a property, and the property owns it: the body carries the
 * property id, but the ownership gate is that property's landlord matching the
 * signed-in account.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const room = await createHostelRoom(landlordIdFromAccount(account), String(body.propertyId || ""), body);
    return Response.json({ ok: true, room }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
