import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { recordCuriosityFeedback, validCuriosityFeedback } from "@/lib/curiosity/feedback";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { curiosityCohortNonce, curiosityFeedbackDedupeHash, validCuriosityFeedbackToken } from "@/lib/curiosity/pilot-access";
import { logEvent } from "@/lib/observability";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin feedback refused.", 403);
    const cohortNonce = await curiosityCohortNonce(request);
    if (!cohortNonce) throw new CampusEngineError("NOT_FOUND", "Guided discovery is not available.", 404);
    if (Number(request.headers.get("content-length") || 0) > 512) throw new CampusEngineError("VALIDATION_ERROR", "Invalid feedback.", 400);
    const reader = request.body?.getReader();
    if (!reader) throw new CampusEngineError("VALIDATION_ERROR", "Invalid feedback.", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512) throw new CampusEngineError("VALIDATION_ERROR", "Invalid feedback.", 400);
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!validCuriosityFeedback(data)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid feedback.", 400);
    if (!await validCuriosityFeedbackToken(data.feedbackToken, data.serviceId, cohortNonce)) throw new CampusEngineError("FORBIDDEN", "This suggestion can no longer be rated.", 403);
    const limited = await rateLimitSubject("curiosity-feedback", cohortNonce, { limit: 30, windowMs: 24 * 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const recorded = await recordCuriosityFeedback({ serviceId: data.serviceId, policyVersion: data.policyVersion, outcome: data.outcome, dedupeHash: await curiosityFeedbackDedupeHash(cohortNonce, data.serviceId) });
    return Response.json({ ok: true, recorded }, { headers });
  } catch (error) {
    if (!(error instanceof CampusEngineError) && !(error instanceof SyntaxError)) logEvent("error", "curiosity_feedback_failed", {});
    const safeError = error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Invalid feedback.", 400)
      : error instanceof CampusEngineError ? error : new CampusEngineError("ENGINE_ERROR", "Feedback is temporarily unavailable.", 500);
    const failure = campusErrorPayload(safeError);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
