import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { isRoomActive, readRoom } from "@/lib/cinema-engine/rooms";
import { cinemaIceServers } from "@/lib/cinema-engine/turn";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * How this room's browsers may connect to each other.
 *
 * Membership is checked here exactly as it is for the socket, because the ICE
 * credentials are the one part of the mesh the server hands out: a stranger who
 * could read them could relay traffic through the deployment's TURN quota. The
 * switches come back with the credentials so the room can hide controls that
 * the policy has turned off, rather than offering a button that always fails.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-rtc", student.id, { limit: 120, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
    if (!room.isMember) {
      throw new CampusEngineError("FORBIDDEN", room.joinLocked ? "The host has locked this room." : "Join the room before connecting to it.", 403);
    }

    const [voice, camera, recordings, maxRecordingMinutes] = await Promise.all([
      platformSettingEnabled("cinema_voice_enabled"),
      platformSettingEnabled("cinema_camera_enabled"),
      platformSettingEnabled("cinema_recordings_enabled"),
      platformSettingNumber("cinema_max_recording_minutes"),
    ]);
    const media = voice || camera;
    const ice = media ? await cinemaIceServers() : { iceServers: [], turn: false };
    return ok({
      voice,
      camera,
      recordings,
      maxRecordingMinutes: Math.max(1, Math.floor(maxRecordingMinutes)),
      iceServers: ice.iceServers,
      turn: ice.turn,
    }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
