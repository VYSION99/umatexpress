import { fail, ok } from "@/lib/campus-engine/responses";
import { verifyCinemaRoomPlanPayment } from "@/lib/cinema-engine/room-plan-subscriptions";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

export async function GET(request: Request, context: { params: Promise<{ reference: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-room-plan-verify", student.id, { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { reference } = await context.params;
    return ok(await verifyCinemaRoomPlanPayment(student.id, reference), { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
