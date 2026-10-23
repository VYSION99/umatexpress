import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { advanceCinemaPlaylist, cinemaUploadsForRoom, reorderCinemaPlaylist } from "@/lib/cinema-engine/uploads";
import { requireCinemaAccount } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: account.id });
    if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join this room to see its playlist.", 403);
    const uploads = (await cinemaUploadsForRoom(id)).filter((upload) => upload.status === "READY");
    return ok({ currentUploadId: room.videoId, phase: room.videoId ? "SCREENING" : uploads.length ? "DISCUSSION" : "SETUP",
      uploads: uploads.map((upload) => ({ id: upload.id, filename: upload.originalFilename, durationSeconds: upload.durationSeconds, position: upload.playlistPosition })) },
    { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request);
    const { id } = await context.params;
    const body = await request.json() as { currentUploadId?: unknown };
    const result = await advanceCinemaPlaylist({ roomId: id, studentId: account.id, currentUploadId: String(body.currentUploadId || "") });
    return ok(result, { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request);
    const { id } = await context.params;
    const body = await request.json() as { uploadIds?: unknown };
    if (!Array.isArray(body.uploadIds) || body.uploadIds.some((value) => typeof value !== "string")) {
      throw new CampusEngineError("VALIDATION_ERROR", "Send the queued file IDs in playback order.", 400);
    }
    return ok(await reorderCinemaPlaylist({ roomId: id, studentId: account.id, uploadIds: body.uploadIds as string[] }), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}
