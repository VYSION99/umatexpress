import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { requestLoginCode } from "@/lib/auth-recovery";
import { logEvent } from "@/lib/observability";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { registerCinemaAudience, studentSessionCookie } from "@/lib/student-auth";

/** An audience account grants Cinema attendance only; student services still check the UMaT domain. */
export async function PUT(request: Request) {
  try {
    const limited = await rateLimit(request, "cinema-audience-signup", { limit: 12, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { email?: unknown; password?: unknown; name?: unknown };
    const account = await registerCinemaAudience(body);
    await requestLoginCode({ scope: "STUDENT", email: account.email }).catch((error) => {
      logEvent("error", "cinema_audience_verification_queue_failed", { reason: error instanceof Error ? error.message : "unknown" });
    });
    return ok({ account }, { status: 201, headers: { "Set-Cookie": await studentSessionCookie(account.id, request), "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter your account details.", 400) : error, request);
  }
}
