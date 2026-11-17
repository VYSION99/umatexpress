import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { reportPrintCopyListing } from "@/lib/print-copy/directory";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin report refused.", 403);
    const limited = await rateLimit(request, "print-copy-listing-report", { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { providerId?: unknown; category?: unknown; message?: unknown };
    return Response.json({ ok: true, report: await reportPrintCopyListing({ providerId: body.providerId, category: body.category, message: body.message }) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the correction details.", 400) : error);
    return Response.json(failure.body, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
