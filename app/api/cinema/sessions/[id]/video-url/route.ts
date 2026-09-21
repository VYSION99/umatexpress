import { fail, ok } from "@/lib/campus-engine/responses";
import { issueCinemaPlayback } from "@/lib/cinema-engine/media";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A member asks for a lease on the room's video. The answer is short-lived by
 * design: a player that outlives it asks again, and a room that ends stops
 * issuing new ones. Members only — the URL is the authorisation after this.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-video-url", student.id, { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const playback = await issueCinemaPlayback({ roomId: id, studentId: student.id });
    return ok(playback, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
