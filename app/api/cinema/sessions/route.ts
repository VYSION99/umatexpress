import { fail, ok } from "@/lib/campus-engine/responses";
import { createRoom, listMyRooms } from "@/lib/cinema-engine/rooms";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The student's rooms: create one, or read back the ones they are already in.
 *
 * Creating a room is cheap but not free — every room is a row and a share link
 * — so it is rate limited per caller, the way every write on the platform is.
 * Reading the lobby is not: a student may reload their own list as often as
 * they like. The lobby's choices travel in the same body: its video source,
 * who may join, and — since M12 — when the room goes live and how long it
 * runs. The engine keeps the final word on every one of them, and a file
 * always means a private room.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "cinema-room-create", { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const body = await request.json() as { title?: string; video?: string; source?: string; visibility?: string; startInMinutes?: number; durationMinutes?: number };
    const room = await createRoom({
      student,
      title: body.title,
      video: body.video,
      source: body.source,
      visibility: body.visibility,
      startInMinutes: body.startInMinutes,
      durationMinutes: body.durationMinutes,
    });
    return ok({ room }, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    const rooms = await listMyRooms(student.id);
    return ok({ rooms }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
