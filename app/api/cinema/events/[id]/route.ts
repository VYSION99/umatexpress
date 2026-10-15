import { fail, ok } from "@/lib/campus-engine/responses";
import { readPublicCinemaEvent, setCinemaEventRsvp, submitCinemaEventFeedback } from "@/lib/cinema-engine/events";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireCinemaAccount, studentAccountFromRequest } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await studentAccountFromRequest(request); const { id } = await context.params;
    return ok({ event: await readPublicCinemaEvent(id, student?.id) }, { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request); const { id } = await context.params;
    const limited = await rateLimitSubject("cinema-event-action", student.id, { limit: 30, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    if (String(body.action).toUpperCase() === "FEEDBACK") return ok({ event: await submitCinemaEventFeedback({ id, studentId: student.id, rating: body.rating, comment: body.comment }) }, { headers: NO_STORE }, request);
    return ok({ event: await setCinemaEventRsvp({ id, student, going: String(body.action).toUpperCase() !== "CANCEL_RSVP" }) }, { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}
