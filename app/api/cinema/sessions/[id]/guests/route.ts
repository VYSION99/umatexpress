import { fail, ok } from "@/lib/campus-engine/responses";
import { removeRoomGuest } from "@/lib/cinema-engine/rooms";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The host removing a guest from the room itself.
 *
 * `DELETE .../invites` takes an invitation back; this goes further, because a
 * guest who already walked in still holds a membership row and an open socket.
 * The engine deletes the invitation and the membership together and closes the
 * sockets, so a removal means the person is out of the presence list rather
 * than merely uninvited. Only the host may call it; the engine answers anyone
 * else with the same 403 it gives every other host verb.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-room-guests", student.id, { limit: 120, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const guestId = new URL(request.url).searchParams.get("studentId") || "";
    const result = await removeRoomGuest({ id, studentId: student.id, guestId });
    return ok(result, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
