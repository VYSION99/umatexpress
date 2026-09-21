import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { fileCinemaReport } from "@/lib/cinema-engine/signals";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A student reports a room, one message in it, or the room's uploaded video.
 *
 * Membership is required: a report is something said from inside the room, and
 * requiring the join means the reporter is a person the platform can account
 * for rather than a link someone pasted elsewhere. The report blocks nothing —
 * a moderator reads it and decides.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = await rateLimit(request, "cinema-report", { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Only someone in the room can report it.", 403);
    const body = await request.json() as { messageId?: unknown; reason?: unknown; video?: unknown };
    const report = await fileCinemaReport({
      sessionId: room.id,
      sessionTitle: room.title,
      reporter: { id: student.id, name: student.name },
      messageId: body.messageId,
      video: body.video,
      reason: body.reason,
    });
    return ok({ report }, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
