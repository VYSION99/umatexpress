import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertSameOrigin, fail, ok } from "@/lib/campus-engine/responses";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { studentAccountFromRequest } from "@/lib/student-auth";
import { requestStudentEmailClaim, studentEmailClaim, verifyStudentEmailClaim } from "@/lib/student-email-claims";
import { validStudentEmail } from "@/lib/student-email";

const headers = { "Cache-Control": "no-store" };

async function accountForClaim(request: Request, requireVerified = false) {
  const account = await studentAccountFromRequest(request);
  if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to your UMaTeXPRESS account.", 401);
  if (!account.emailVerified && (requireVerified || account.verificationRequired)) throw new CampusEngineError("FORBIDDEN", "Verify your account email first.", 403);
  return account;
}

export async function GET(request: Request) {
  try {
    const account = await accountForClaim(request);
    const primaryStudent = validStudentEmail(account.email);
    const claim = primaryStudent ? { studentEmail: account.email, verified: true, expiresAt: "" } : await studentEmailClaim(account.id);
    return ok({ studentAccess: claim }, { headers }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request, "Cross-origin student email request refused.");
    const account = await accountForClaim(request, true);
    if (validStudentEmail(account.email)) throw new CampusEngineError("CONFLICT", "Your verified sign-in email already grants student access.", 409);
    const limited = await rateLimitSubject("student-email-claim-request", account.id, { limit: 3, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { studentEmail?: unknown };
    return ok({ studentAccess: await requestStudentEmailClaim(account.id, body.studentEmail) }, { headers }, request);
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request, "Cross-origin student email verification refused.");
    const account = await accountForClaim(request, true);
    const limited = await rateLimitSubject("student-email-claim-verify", account.id, { limit: 12, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { code?: unknown };
    return ok({ studentAccess: await verifyStudentEmailClaim(account.id, body.code) }, { headers }, request);
  } catch (error) { return fail(error, request); }
}
