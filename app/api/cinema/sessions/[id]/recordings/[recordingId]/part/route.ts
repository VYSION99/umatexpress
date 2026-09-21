import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { CINEMA_UPLOAD_PART_BYTES } from "@/lib/cinema-engine/uploads";
import { putCinemaRecordingPart } from "@/lib/cinema-engine/recordings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One part of a recording. Only the recorder can address the take, and the part
 * number and size are checked against what begin declared before R2 sees them.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string; recordingId: string }> }) {
  try {
    const student = await requireStudent(request);
    const claimed = Number(request.headers.get("content-length") || 0);
    if (claimed > CINEMA_UPLOAD_PART_BYTES) {
      throw new CampusEngineError("VALIDATION_ERROR", "That part is larger than this recording sends.", 413);
    }
    const limited = await rateLimitSubject("cinema-recording-part", student.id, { limit: 400, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { recordingId } = await context.params;
    const partNumber = new URL(request.url).searchParams.get("n");
    const body = await request.arrayBuffer();
    const stored = await putCinemaRecordingPart({ recordingId, studentId: student.id, partNumber, body });
    return ok({ part: stored }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
