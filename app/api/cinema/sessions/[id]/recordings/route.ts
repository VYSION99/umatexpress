import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { isRoomActive, readRoom } from "@/lib/cinema-engine/rooms";
import {
  abortCinemaRecording,
  beginCinemaRecording,
  cinemaRecordingLimits,
  listCinemaRecordings,
  publicCinemaRecording,
} from "@/lib/cinema-engine/recordings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A member's recordings in one room: list them, start one, or give one up.
 *
 * The take is the recorder's own, so membership — not hosting — is the door.
 * Nothing here is visible to the rest of the room; the room learns that a
 * recording is running over the socket, which is the honest half of a feature
 * that captures voices.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-recordings-list", student.id, { limit: 240, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
    if (!room.isMember) {
      throw new CampusEngineError("FORBIDDEN", room.joinLocked ? "The host has locked this room." : "Join the room before recording in it.", 403);
    }
    const recordings = await listCinemaRecordings({ roomId: room.id, studentId: student.id });
    return ok({ recordings: recordings.map(publicCinemaRecording), limits: await cinemaRecordingLimits() }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-recording-start", student.id, { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { mimeType?: unknown; sizeBytes?: unknown; durationSeconds?: unknown };
    const started = await beginCinemaRecording({
      roomId: id,
      studentId: student.id,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      durationSeconds: body.durationSeconds,
    });
    return ok({
      recording: publicCinemaRecording(started.recording),
      partBytes: started.partBytes,
      parts: started.parts,
    }, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    const student = await requireStudent(request);
    const recordingId = new URL(request.url).searchParams.get("recordingId") || "";
    if (!recordingId) throw new CampusEngineError("VALIDATION_ERROR", "A recording id is required.", 400);
    const result = await abortCinemaRecording({ recordingId, studentId: student.id });
    return ok({ aborted: result.aborted }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
