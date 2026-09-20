import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { landlordIdFromAccount, updateHostelRoom } from "@/lib/hostel-engine/landlord";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Edit a room: rename it, change the fee, grow or shrink its beds, retire it. */
export async function PATCH(request: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { roomId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const room = await updateHostelRoom(landlordIdFromAccount(account), String(roomId || ""), body);
    return Response.json({ ok: true, room }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
