import { fail, ok } from "@/lib/campus-engine/responses";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { abortCinemaUpload, beginCinemaUpload, cinemaUploadForRoom, cinemaUploadLimits } from "@/lib/cinema-engine/uploads";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The room's one upload: read its state, start it, or give it up.
 *
 * Starting is the host's word only, and the ownership question is answered
 * before a byte is accepted — the platform will not be the place a video
 * appears without somebody saying they had the right to share it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    if (!room.isHost) throw new CampusEngineError("FORBIDDEN", "Only the host can manage this room's upload.", 403);
    const upload = await cinemaUploadForRoom(room.id);
    return ok({ upload: upload && upload.status !== "DELETED" ? publicUpload(upload) : null, limits: await cinemaUploadLimits() }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-upload-start", student.id, { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { filename?: unknown; sizeBytes?: unknown; contentType?: unknown; ownershipConfirmed?: unknown };
    const started = await beginCinemaUpload({
      roomId: id,
      studentId: student.id,
      filename: body.filename,
      sizeBytes: body.sizeBytes,
      contentType: body.contentType,
      ownershipConfirmed: body.ownershipConfirmed,
    });
    return ok({ upload: publicUpload(started.upload), partBytes: started.partBytes, parts: started.parts }, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    const result = await abortCinemaUpload({ roomId: id, studentId: student.id });
    return ok({ aborted: result.aborted }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

/** The object key never leaves the server; the id and the metadata can. */
function publicUpload(upload: { id: string; status: string; originalFilename: string; fileSizeBytes: number; mimeType: string; durationSeconds: number; createdAt: string }) {
  return {
    id: upload.id,
    status: upload.status,
    filename: upload.originalFilename,
    sizeBytes: upload.fileSizeBytes,
    mimeType: upload.mimeType,
    durationSeconds: upload.durationSeconds,
    createdAt: upload.createdAt,
  };
}
