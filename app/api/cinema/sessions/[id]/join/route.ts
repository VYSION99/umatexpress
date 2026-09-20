import { fail, ok } from "@/lib/campus-engine/responses";
import { joinRoom } from "@/lib/cinema-engine/rooms";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Joining a room writes membership. It is idempotent — a reload is not a second
 * join — and it is rate limited, because a join is the one write a stranger to a
 * shared link can trigger without the host's involvement.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = await rateLimit(request, "cinema-room-join", { limit: 60, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const { id } = await context.params;
    const room = await joinRoom({ id, student });
    return ok({ room }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
