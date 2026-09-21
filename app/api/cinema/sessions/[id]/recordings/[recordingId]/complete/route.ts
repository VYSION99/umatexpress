import { fail, ok } from "@/lib/campus-engine/responses";
import { completeCinemaRecording, publicCinemaRecording } from "@/lib/cinema-engine/recordings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The recorder says every part has arrived. The bucket's own report of the
 * finished object decides whether the take is READY.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; recordingId: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-recording-finish", student.id, { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { recordingId } = await context.params;
    const body = await request.json() as { parts?: unknown };
    const result = await completeCinemaRecording({ recordingId, studentId: student.id, parts: body.parts });
    return ok({ recording: publicCinemaRecording(result.recording) }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
