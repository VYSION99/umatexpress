import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { CINEMA_UPLOAD_PART_BYTES, putCinemaUploadPart } from "@/lib/cinema-engine/uploads";
import { CINEMA_ROOM_PLANS } from "@/lib/cinema-engine/room-plans";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_PLAYLIST = CINEMA_ROOM_PLANS.PRO_PLUS;
const HOURLY_PART_BUDGET = Math.ceil(MAX_PLAYLIST.bytes / CINEMA_UPLOAD_PART_BYTES) + MAX_PLAYLIST.files + 200;

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
    // Allow a full playlist, a final partial chunk per file, and retries.
    const limited = await rateLimitSubject("cinema-upload-part", student.id, { limit: HOURLY_PART_BUDGET, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    const partNumber = query.get("n");
    const body = await request.arrayBuffer();
    const stored = await putCinemaUploadPart({ roomId: id, studentId: student.id, uploadId: query.get("uploadId") || undefined, partNumber, body });
    return ok({ part: stored }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
