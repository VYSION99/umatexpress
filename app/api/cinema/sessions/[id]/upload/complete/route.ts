import { fail, ok } from "@/lib/campus-engine/responses";
import { completeCinemaUpload } from "@/lib/cinema-engine/uploads";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The client says every part has arrived. That is a claim: the bucket's own
 * report of the finished object is what marks the room playable, and a mismatch
 * fails the upload rather than the room.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-upload-finish", student.id, { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { parts?: unknown };
    const result = await completeCinemaUpload({ roomId: id, studentId: student.id, parts: body.parts });
    return ok({
      upload: {
        id: result.upload.id,
        status: result.upload.status,
        sizeBytes: result.upload.fileSizeBytes,
        mimeType: result.upload.mimeType,
        durationSeconds: result.upload.durationSeconds,
      },
    }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
