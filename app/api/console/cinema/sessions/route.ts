import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listRoomsForConsole } from "@/lib/cinema-engine/rooms";
import { requireConsoleRole } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The staff room list: every study room, live or recently ended, with the host
 * and the member count. Reading is not a mutation, so it is only rate limited
 * against a runaway tab, not against a moderators' working session.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-console-rooms", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const rooms = await listRoomsForConsole({
      status: url.searchParams.get("status"),
      q: url.searchParams.get("q"),
    });
    return Response.json({
      ok: true,
      rooms,
      summary: {
        listed: rooms.length,
        live: rooms.filter((room) => room.status === "LIVE").length,
        waiting: rooms.filter((room) => room.status === "CREATED").length,
        ended: rooms.filter((room) => room.status === "ENDED").length,
      },
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
