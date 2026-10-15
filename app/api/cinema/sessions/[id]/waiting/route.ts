import { fail, ok } from "@/lib/campus-engine/responses";
import { decideWaitingMember, listWaitingMembers } from "@/lib/cinema-engine/rooms";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request);
    const { id } = await context.params;
    return ok({ waiting: await listWaitingMembers({ id, studentId: student.id }) }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-waiting-decisions", student.id, { limit: 120, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { studentId?: string; action?: string };
    return ok(await decideWaitingMember({ id, studentId: student.id, guestId: body.studentId, action: body.action }), { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
