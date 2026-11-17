import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { createPrintCopyQuote, listStudentPrintCopyQuotes } from "@/lib/print-copy/directory";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    return Response.json({ quotes: await listStudentPrintCopyQuotes(student.id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const failure = campusErrorPayload(error);
    return Response.json(failure.body, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin quote request refused.", 403);
    const student = await requireStudent(request);
    const limited = await rateLimit(request, `print-copy-quote:${student.id}`, { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { providerId?: unknown; requirements?: unknown };
    return Response.json({ ok: true, ...await createPrintCopyQuote({ providerId: body.providerId, requirements: body.requirements }, student) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Describe the print job before sending.", 400) : error);
    return Response.json(failure.body, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
