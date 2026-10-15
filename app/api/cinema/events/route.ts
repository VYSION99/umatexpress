import { fail, ok } from "@/lib/campus-engine/responses";
import { createCinemaEvents, listPublicCinemaEvents } from "@/lib/cinema-engine/events";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent, studentAccountFromRequest } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const student = await studentAccountFromRequest(request);
    const params = new URL(request.url).searchParams;
    const events = await listPublicCinemaEvents({ section: params.get("section"), query: params.get("q"), studentId: student?.id });
    return ok({ events }, { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-event-create", student.id, { limit: 12, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const events = await createCinemaEvents({
      student, organizerName: body.organizerName, organizerType: body.organizerType, title: body.title,
      description: body.description, video: body.video, startsAt: body.startsAt, durationMinutes: body.durationMinutes,
      capacity: body.capacity, recurrenceCount: body.recurrenceCount, certificatesEnabled: body.certificatesEnabled,
      format: body.format, stageLimit: body.stageLimit,
    });
    return ok({ events, event: events[0] }, { status: 201, headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}
