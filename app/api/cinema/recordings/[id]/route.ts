import { fail, ok } from "@/lib/campus-engine/responses";
import { cinemaRecordingForRecorder, deleteCinemaRecording, publicCinemaRecording } from "@/lib/cinema-engine/recordings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One recording, for its recorder only.
 *
 * There is no share link and no room-wide listing: the take is the recorder's,
 * and the query filters on their student id rather than checking a flag that
 * could be forgotten. Deleting is the recorder's own hygiene — the retention
 * job is the backstop, not the only way out.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-recording-read", student.id, { limit: 240, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const recording = await cinemaRecordingForRecorder({ recordingId: id, studentId: student.id });
    return ok({ recording: publicCinemaRecording(recording) }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-recording-delete", student.id, { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const result = await deleteCinemaRecording({ recordingId: id, studentId: student.id });
    return ok({ deleted: result.deleted }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
