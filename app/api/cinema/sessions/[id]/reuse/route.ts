import { fail, ok } from "@/lib/campus-engine/responses";
import { reuseCinemaRoom } from "@/lib/cinema-engine/reuse";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = await rateLimit(request, "cinema-room-create", { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const { id } = await context.params;
    const result = await reuseCinemaRoom({ id, student });
    return ok(result, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
