import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom } from "./rooms";
import { cinemaMessagePage, readCinemaMessage } from "./messages";
import { cinemaUploadsForRoom } from "./uploads";
import { turso } from "@/lib/turso";

export async function readCinemaChatHistory(input: { roomId: string; studentId: string; before?: number; after?: number; through?: number; threadId?: string }) {
  const room = await readRoom({ id: input.roomId, studentId: input.studentId });
  if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join this room to read its chat.", 403);
  return cinemaMessagePage({ ...input, sessionId: room.id });
}

/** Only a stored reference can move playback; callers cannot supply another file or time. */
export async function activateCinemaChatMoment(input: { roomId: string; studentId: string; messageId: string }) {
  const room = await readRoom({ id: input.roomId, studentId: input.studentId });
  if (!room.isMember || !["HOST", "COHOST", "PRESENTER"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only a host, co-host or presenter can move room playback.", 403);
  if (!["CREATED", "LIVE"].includes(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  const message = await readCinemaMessage(input.messageId);
  if (!message || message.removed || message.sessionId !== room.id || !message.video || message.atSeconds === null) throw new CampusEngineError("NOT_FOUND", "This video reference is no longer available.", 404);
  if (message.video.sourceType !== room.sourceType) throw new CampusEngineError("INVALID_STATE", "This room no longer uses that video source.", 409);
  if (message.video.videoId !== room.videoId && !["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Ask the host or a co-host to return to that video.", 403);
  let durationSeconds = 0;
  if (room.sourceType === "UPLOAD") {
    const upload = (await cinemaUploadsForRoom(room.id)).find(upload => upload.id === message.video!.videoId && upload.status === "READY");
    if (!upload) throw new CampusEngineError("NOT_FOUND", "That video has been removed from this room.", 404);
    durationSeconds = upload.durationSeconds;
  } else if (room.videoId !== message.video.videoId) throw new CampusEngineError("NOT_FOUND", "That video is no longer available in this room.", 404);
  const changed = await turso("UPDATE cinema_sessions SET video_id=?,updated_at=? WHERE id=? AND video_id=? AND status IN ('CREATED','LIVE')", [message.video.videoId, new Date().toISOString(), room.id, room.videoId]);
  if (!Number(changed.affected_row_count || 0)) throw new CampusEngineError("CONFLICT", "Playback changed. Try opening the reference again.", 409);
  return { ...message.video, positionSeconds: Math.min(durationSeconds || 86400, message.atSeconds), durationSeconds };
}
