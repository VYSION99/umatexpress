import { changeDriverPassword, clearDriverSessionCookie, driverSessionCookie, verifyDriverCredentials } from "@/lib/campus-engine/driver-auth";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "driver-auth", { limit: 10, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { identifier?: string; password?: string };
    const identifier = String(body.identifier || "");
    const subject = identifier.trim().toLowerCase();
    const lock = await authGuardStatus("driver-login", subject);
    if (lock.locked) return rateLimitResponse(lock.retryAfter);
    const driver = await verifyDriverCredentials(identifier, String(body.password || ""));
    if (!driver) {
      const failure = await authGuardFailure("driver-login", subject);
      throw new CampusEngineError("UNAUTHORIZED", failure.locked ? "Too many failed sign-in attempts. Try again later." : "Invalid driver login details.", failure.locked ? 429 : 401);
    }
    await authGuardClear("driver-login", subject);
    return ok({ driver }, { headers: { "Set-Cookie": await driverSessionCookie(driver.id, request) } });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request) {
  return ok({ signedOut: true }, { headers: { "Set-Cookie": clearDriverSessionCookie(request) } });
}

export async function PATCH(request: Request) {
  try {
    const limited = await rateLimit(request, "driver-password-change", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const result = await changeDriverPassword(request, await request.json());
    // Password change rotates the session version, so reissue the cookie to keep this device signed in.
    return ok(result, { headers: { "Set-Cookie": await driverSessionCookie(result.driverId, request) } });
  } catch (error) {
    return fail(error);
  }
}
