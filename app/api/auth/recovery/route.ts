import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import {
  isAuthRecoveryScope, requestLoginCode, requestPasswordReset, resetPassword, type AuthRecoveryScope,
} from "@/lib/auth-recovery";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * Account recovery for every auth surface.
 *
 *   POST   start a password reset (always answers the same, known or not)
 *   PUT    send a one-time sign-in code
 *   PATCH  finish a reset, by link token or by emailed code
 *
 * The scope says which account table is involved: `STUDENT` for the one
 * UMaTeXPRESS account, `CONSOLE` for every console role. Nothing here reveals
 * whether an address has an account.
 */
function scopeOrThrow(value: unknown): AuthRecoveryScope {
  const scope = String(value || "STUDENT").trim().toUpperCase();
  if (!isAuthRecoveryScope(scope)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid account type.", 400);
  return scope;
}

function originOf(request: Request) {
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "auth-recovery", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { scope?: unknown; email?: unknown };
    const scope = scopeOrThrow(body.scope);
    const result = await requestPasswordReset({ scope, email: body.email, origin: originOf(request) });
    // The same answer for every address: asking is not a way to test who exists.
    return ok({ requested: true, expiresAt: result.expiresAt }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function PUT(request: Request) {
  try {
    const limited = await rateLimit(request, "auth-otp-request", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { scope?: unknown; email?: unknown };
    const scope = scopeOrThrow(body.scope);
    const result = await requestLoginCode({ scope, email: body.email });
    return ok({ requested: true, expiresAt: result.expiresAt }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    const limited = await rateLimit(request, "auth-recovery-reset", { limit: 10, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { scope?: unknown; token?: unknown; email?: unknown; code?: unknown; newPassword?: unknown };
    const scope = scopeOrThrow(body.scope);
    const result = await resetPassword({ scope, token: body.token, email: body.email, code: body.code, newPassword: body.newPassword });
    // No session is minted here on purpose: a reset proves the inbox, and the
    // next sign-in with the new password proves the person.
    return ok(result, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
