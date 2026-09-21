import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { CINEMA_UPLOAD_PART_BYTES, putCinemaUploadPart } from "@/lib/cinema-engine/uploads";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One part of an upload. The request body is the bytes and nothing else, so the
 * Worker can hand the buffer straight to the bucket after the host, room and
 * size checks have passed.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const claimed = Number(request.headers.get("content-length") || 0);
    if (claimed > CINEMA_UPLOAD_PART_BYTES) {
      throw new CampusEngineError("VALIDATION_ERROR", "That part is larger than this upload sends.", 413);
    }
    // A 2 GB file is 256 parts; this bounds a runaway tab without bounding a file.
    const limited = await rateLimitSubject("cinema-upload-part", student.id, { limit: 400, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const partNumber = new URL(request.url).searchParams.get("n");
    const body = await request.arrayBuffer();
    const stored = await putCinemaUploadPart({ roomId: id, studentId: student.id, partNumber, body });
    return ok({ part: stored }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
