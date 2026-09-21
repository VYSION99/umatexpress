import { fail, ok } from "@/lib/campus-engine/responses";
import { inviteToRoom, listRoomInvites, removeRoomInvite } from "@/lib/cinema-engine/rooms";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A private room's guest list, for its host.
 *
 * An invitation is an address rather than an id because that is what a host
 * has: the engine resolves the UMaT email to the one account it belongs to, so
 * a list can never point at a student who does not exist. Every verb is
 * host-only, and taking an invitation back closes the door without touching
 * the membership of anyone already inside.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-room-invites", student.id, { limit: 240, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const invites = await listRoomInvites({ id, studentId: student.id });
    return ok(invites, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-room-invites", student.id, { limit: 240, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { email?: string };
    const result = await inviteToRoom({ id, studentId: student.id, email: body.email });
    return ok(result, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-room-invites", student.id, { limit: 240, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const inviteeId = new URL(request.url).searchParams.get("studentId") || "";
    const result = await removeRoomInvite({ id, studentId: student.id, inviteeId });
    return ok(result, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
