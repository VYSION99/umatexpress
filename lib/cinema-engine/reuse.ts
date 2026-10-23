import { CampusEngineError } from "@/lib/campus-engine/errors";
import { activeCinemaRoomPlan } from "@/lib/cinema-engine/room-plans";
import { createRoom, patchRoom } from "@/lib/cinema-engine/rooms";
import { acquireReusableRoom, activateReusableRoom, releaseReusableRoom, reusableRoomById, reusableRoomForSession, saveLegacyCinemaRoom } from "@/lib/cinema-engine/reusable-rooms";

/** A stable room link points at a fresh temporary session each time the host starts again. */
export async function reuseCinemaRoom(input: { id: string; student: { id: string; name?: string } }) {
  const profile = await reusableRoomById(input.id) || await reusableRoomForSession(input.id)
    || await saveLegacyCinemaRoom(input.id, input.student.id);
  if (!profile || profile.hostStudentId !== input.student.id) throw new CampusEngineError("FORBIDDEN", "Only the host can start this room again.", 403);
  if (profile.currentStatus === "LIVE" || profile.currentStatus === "CREATED") {
    return { stableId: profile.id, sessionId: profile.currentSessionId, reused: false };
  }
  const token = await acquireReusableRoom(profile.id, profile.currentSessionId);
  let newSessionId = "";
  try {
    const uploadLimit = profile.sourceType === "UPLOAD" ? (await activeCinemaRoomPlan(input.student.id)).minutes : 0;
    const durationMinutes = uploadLimit && profile.durationMinutes ? Math.min(uploadLimit, profile.durationMinutes) : profile.durationMinutes;
    const room = await createRoom({
      student: input.student, title: profile.title, source: profile.sourceType,
      video: profile.sourceType === "YOUTUBE" ? profile.videoId : "",
      visibility: profile.visibility, startInMinutes: 0, durationMinutes,
    });
    newSessionId = room.id;
    await activateReusableRoom(profile, token, room.id);
    return { stableId: profile.id, sessionId: room.id, reused: true };
  } catch (error) {
    if (newSessionId) await patchRoom({ id: newSessionId, studentId: input.student.id, action: "END" }).catch(() => undefined);
    throw error;
  } finally {
    await releaseReusableRoom(profile.id, token).catch(() => undefined);
  }
}
