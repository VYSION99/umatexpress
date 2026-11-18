import {
  changeStudentPassword,
  clearStudentSessionCookie,
  registerStudent,
  studentAccountFromRequest,
  studentSessionCookie,
  updateStudentProfile,
  verifyStudentCredentials,
} from "@/lib/student-auth";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertSameOrigin, fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";
import { requestLoginCode } from "@/lib/auth-recovery";
import { logEvent } from "@/lib/observability";

/**
 * The shared UMaTeXPRESS account endpoint. Service access is checked at each
 * destination after the session cookie is set here.
 *
 *   GET    who is signed in (never throws: browsing does not need an account)
 *   POST   sign in
 *   PUT    create an account
 *   PATCH  save name/phone, or change the password when `newPassword` is sent
 *   DELETE sign out
 */
export async function GET(request: Request) {
  try {
    return ok({ account: await studentAccountFromRequest(request) }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request, "Cross-origin sign-in refused.");
    const limited = await rateLimit(request, "student-signin", { limit: 10, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { email?: string; password?: string };
    const subject = String(body.email || "").trim().toLowerCase();
    const lock = await authGuardStatus("student-login", subject);
    if (lock.locked) return rateLimitResponse(lock.retryAfter);
    const account = await verifyStudentCredentials(body.email, String(body.password || ""));
    if (!account) {
      const failure = await authGuardFailure("student-login", subject);
      throw new CampusEngineError("UNAUTHORIZED", failure.locked ? "Too many failed sign-in attempts. Try again later." : "That email and password do not match an account.", failure.locked ? 429 : 401);
    }
    await authGuardClear("student-login", subject);
    return ok({ account }, { headers: { "Set-Cookie": await studentSessionCookie(account.id, request), "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request, "Cross-origin registration refused.");
    // Campus networks can share an IP. Keep a moderate per-IP cap while
    // password strength, email verification, and the unique index guard sign-up.
    const limited = await rateLimit(request, "student-signup", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const account = await registerStudent(await request.json());
    // A new account may sign in to verify its address, but cannot use services
    // until the emailed one-time code proves ownership.
    await requestLoginCode({ scope: "STUDENT", email: account.email }).catch(error => {
      logEvent("error", "signup_verification_queue_failed", { reason: error instanceof Error ? error.message : "unknown" });
    });
    return ok({ account }, { status: 201, headers: { "Set-Cookie": await studentSessionCookie(account.id, request), "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request, "Cross-origin account update refused.");
    const body = await request.json() as { name?: string; phone?: string; currentPassword?: string; newPassword?: string };
    if (typeof body.newPassword === "string" && body.newPassword) {
      const limited = await rateLimit(request, "student-password-change", { limit: 6, windowMs: 15 * 60_000 });
      if (!limited.ok) return rateLimitResponse(limited.retryAfter);
      const result = await changeStudentPassword(request, body);
      // The password change rotates token_version, so reissue this device's cookie.
      return ok(result, { headers: { "Set-Cookie": await studentSessionCookie(result.accountId, request), "Cache-Control": "no-store" } }, request);
    }
    const limited = await rateLimit(request, "student-profile", { limit: 30, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return ok({ account: await updateStudentProfile(request, body) }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request, "Cross-origin sign-out refused.");
    return ok({ signedOut: true }, { headers: { "Set-Cookie": clearStudentSessionCookie(request), "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
