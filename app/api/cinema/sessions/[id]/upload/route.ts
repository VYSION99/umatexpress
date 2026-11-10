import { fail, ok } from "@/lib/campus-engine/responses";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { abortCinemaUpload, beginCinemaUpload, cinemaUploadsForRoom, cinemaUploadLimits } from "@/lib/cinema-engine/uploads";
import { snapshotCinemaRoomAllowance } from "@/lib/cinema-engine/room-plans";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The room's upload queue. A host can start or cancel the file in progress.
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
    const uploads = await cinemaUploadsForRoom(room.id);
    const allowance = await snapshotCinemaRoomAllowance(room.id, student.id);
    const selected = uploads.find((item) => item.status === "UPLOADING") || uploads[0] || null;
    return ok({ upload: selected ? publicUpload(selected) : null, currentUploadId: room.videoId,
      uploads: uploads.map(publicUpload), allowance, limits: await cinemaUploadLimits() }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    // Leave room for retries when filling a 15-video playlist.
    const limited = await rateLimitSubject("cinema-upload-start", student.id, { limit: 20, windowMs: 60 * 60_000 });
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
    const result = await abortCinemaUpload({ roomId: id, studentId: student.id, uploadId: new URL(request.url).searchParams.get("uploadId") || undefined });
    return ok({ aborted: result.aborted }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

/** The object key never leaves the server; the id and the metadata can. */
function publicUpload(upload: { id: string; status: string; originalFilename: string; fileSizeBytes: number; mimeType: string; durationSeconds: number; createdAt: string; playlistPosition: number }) {
  return {
    id: upload.id,
    status: upload.status,
    filename: upload.originalFilename,
    sizeBytes: upload.fileSizeBytes,
    mimeType: upload.mimeType,
    durationSeconds: upload.durationSeconds,
    createdAt: upload.createdAt,
    playlistPosition: upload.playlistPosition,
  };
}
