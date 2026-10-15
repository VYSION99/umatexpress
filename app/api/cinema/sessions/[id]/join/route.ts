import { fail, ok } from "@/lib/campus-engine/responses";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { joinRoom, readRoom } from "@/lib/cinema-engine/rooms";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";
import { validStudentEmail } from "@/lib/student-email";

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
    const student = await requireCinemaAccount(request);
    const { id } = await context.params;
    const preview = await readRoom({ id, studentId: student.id });
    if (!preview.discussionMode && !validStudentEmail(student.email)) throw new CampusEngineError("FORBIDDEN", "Only UMaT student accounts can join regular Cinema rooms.", 403);
    const room = await joinRoom({ id, student });
    return ok({ room }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
