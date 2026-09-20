import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { isAuthRecoveryScope, verifyLoginCode, type AuthRecoveryScope } from "@/lib/auth-recovery";
import { consoleAudit } from "@/lib/console-audit";
import { consoleSessionCookie, recordConsoleLogin, type ConsoleRole } from "@/lib/console-auth";
import { studentSessionCookie } from "@/lib/student-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * One-time sign-in codes, for the same two account surfaces as recovery. A code
 * is only ever sent to an address that already has an account, and verifying it
 * opens exactly the session that password sign-in would.
 *
 *   PATCH  verify the code and sign in
 */
export async function PATCH(request: Request) {
  try {
    const limited = await rateLimit(request, "auth-otp-verify", { limit: 12, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { scope?: unknown; email?: unknown; code?: unknown };
    const requested = String(body.scope || "STUDENT").trim().toUpperCase();
    if (!isAuthRecoveryScope(requested)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid account type.", 400);
    const scope: AuthRecoveryScope = requested;
    const account = await verifyLoginCode({ scope, email: body.email, code: body.code });
    if (!account) throw new CampusEngineError("UNAUTHORIZED", "That code is not correct, has expired, or was already used.", 401);

    if (scope === "STUDENT") {
      return ok(
        { authenticated: true, account: { id: account.id, email: account.email, name: account.name } },
        { headers: { "Set-Cookie": await studentSessionCookie(account.id, request), "Cache-Control": "no-store" } },
        request,
      );
    }

    await recordConsoleLogin(account.id);
    await consoleAudit({
      actor: account.email,
      action: "CONSOLE_SIGN_IN",
      targetType: "console_account",
      targetReference: account.id,
      details: { role: account.role, method: "OTP" },
    }).catch(() => undefined);
    return ok(
      { authenticated: true, account: { id: account.id, email: account.email, name: account.name, role: account.role } },
      { headers: { "Set-Cookie": await consoleSessionCookie({ id: account.id, role: account.role as ConsoleRole }, request), "Cache-Control": "no-store" } },
      request,
    );
  } catch (error) {
    return fail(error, request);
  }
}
