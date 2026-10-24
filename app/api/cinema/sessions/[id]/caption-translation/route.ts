import { fail, ok } from "@/lib/campus-engine/responses";
import { translateCinemaCaption } from "@/lib/cinema-engine/transcripts";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-caption-translation", student.id, { limit: 30, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { segmentId?: unknown; language?: unknown };
    return ok(await translateCinemaCaption({ id, studentId: student.id, segmentId: body.segmentId, language: body.language }), { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
