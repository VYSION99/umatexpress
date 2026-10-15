import { fail, ok } from "@/lib/campus-engine/responses";
import { listMyCinemaOrganizers, requestCinemaOrganizer } from "@/lib/cinema-engine/events";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    return ok({ organizers: await listMyCinemaOrganizers(student.id) }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-organizer-request", student.id, { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    return ok({ organizer: await requestCinemaOrganizer({ studentId: student.id, name: body.name, type: body.type, affiliation: body.affiliation }) }, { status: 201, headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
