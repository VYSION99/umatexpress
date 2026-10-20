import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { submitFoodCare } from "@/lib/food/operations";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin support request refused.", 403);
    const student = await requireStudent(request);
    const limited = await rateLimit(request, "food-student-care", { limit: 8, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    return Response.json({ ok: true, result: await submitFoodCare(body, student) }, { status: 201, headers });
  } catch (error) {
    const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the support details.", 400) : error);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
