import { fail } from "@/lib/campus-engine/responses";
import { cinemaEventPoster, uploadCinemaEventPoster } from "@/lib/cinema-engine/events";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params; const poster = await cinemaEventPoster(id);
    return new Response(poster.body, { headers: { "content-type": poster.contentType, "cache-control": "public, max-age=300, stale-while-revalidate=3600", ...(poster.etag ? { etag: poster.etag } : {}) } });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request); const { id } = await context.params;
    const limited = await rateLimitSubject("cinema-event-poster", student.id, { limit: 12, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const contentType = String(request.headers.get("content-type") || "").split(";")[0].trim();
    const event = await uploadCinemaEventPoster({ id, studentId: student.id, body: await request.arrayBuffer(), contentType });
    return Response.json({ event }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
