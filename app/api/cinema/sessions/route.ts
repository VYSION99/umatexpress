import { fail, ok } from "@/lib/campus-engine/responses";
import { createRoom, listMyRooms } from "@/lib/cinema-engine/rooms";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The student's rooms: create one, or read back the ones they are already in.
 *
 * Creating a room is cheap but not free — every room is a row and a share link
 * — so it is rate limited per student. Reading the lobby is not: a student may
 * reload their own list as often as they like.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "cinema-room-create", { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const body = await request.json() as { title?: string; video?: string };
    const room = await createRoom({ student, title: body.title, video: body.video });
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
