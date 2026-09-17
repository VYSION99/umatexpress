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
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";

/**
 * The one UMaTeXPRESS account endpoint. campusRide and vacationRide both use the
 * session cookie set here, so a student signs in once for the whole platform.
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
    // Deliberately loose: a hostel or campus NAT shares one address, so a tight
    // per-IP cap would block genuine students. The domain rule, the password
    // policy and the unique index are what actually bound sign-ups.
    const limited = await rateLimit(request, "student-signup", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const account = await registerStudent(await request.json());
    // Creating an account signs the student straight in; there is no email
    // delivery channel to confirm the address first.
    return ok({ account }, { status: 201, headers: { "Set-Cookie": await studentSessionCookie(account.id, request), "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
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
  return ok({ signedOut: true }, { headers: { "Set-Cookie": clearStudentSessionCookie(request), "Cache-Control": "no-store" } }, request);
}
