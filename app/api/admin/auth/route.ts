import { adminAuthConfigStatus, adminEmailFromRequest, adminSessionCookie, clearAdminSessionCookie, isSecureRequest, validateAdminCredentials } from "@/lib/admin-auth";
import { adminMustChangePassword, changeAdminPassword } from "@/lib/admin-credentials";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";

export async function GET(request: Request) {
  const email = await adminEmailFromRequest(request);
  const mustChangePassword = email ? await adminMustChangePassword(email) : false;
  return Response.json({ authenticated: Boolean(email), email, mustChangePassword, config: await adminAuthConfigStatus() }, { status: email ? 200 : 401, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "admin-auth", { limit: 8, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { email?: string; password?: string; currentPassword?: string; newPassword?: string; mode?: "reset" | "change" };
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");

    if (body.mode === "reset") {
      if (!email || !currentPassword || !newPassword) {
        return Response.json({ error: "Provide the admin email, current password, and the new password." }, { status: 400 });
      }
      const resetLock = await authGuardStatus("admin-reset", email);
      if (resetLock.locked) return rateLimitResponse(resetLock.retryAfter);
      try {
        await changeAdminPassword(email, currentPassword, newPassword);
        await authGuardClear("admin-reset", email);
      } catch (error) {
        await authGuardFailure("admin-reset", email);
        throw error;
      }
      return Response.json({ changed: true, reset: true, mustChangePassword: false }, { headers: { "Cache-Control": "no-store" } });
    }

    const config = await adminAuthConfigStatus();
    if (!config.hasAdminEmails) return Response.json({ error: "ADMIN_EMAILS is missing from this deployment." }, { status: 503 });
    if (!config.hasSessionSecret) return Response.json({ error: "ADMIN_SESSION_SECRET is missing or shorter than 32 characters on this deployment." }, { status: 503 });

    const lock = await authGuardStatus("admin-login", email);
    if (lock.locked) return rateLimitResponse(lock.retryAfter);
    if (!await validateAdminCredentials(email, password)) {
      const failure = await authGuardFailure("admin-login", email);
      return Response.json({ error: failure.locked ? "Too many failed sign-in attempts. Try again later." : "Invalid administrator email or password." }, { status: failure.locked ? 429 : 401 });
    }
    await authGuardClear("admin-login", email);
    const secure = isSecureRequest(request);
    const mustChangePassword = await adminMustChangePassword(email);
    return Response.json({ authenticated: true, email, mustChangePassword }, { headers: { "Set-Cookie": await adminSessionCookie(email, secure), "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign-in failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const email = await adminEmailFromRequest(request);
  if (!email) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    const limited = await rateLimit(request, "admin-password-change", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { mode?: "reset" | "change"; currentPassword?: string; newPassword?: string };
    const mode = body.mode === "reset" ? "reset" : "change";
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");

    if (mode === "reset") {
      await changeAdminPassword(email, currentPassword, newPassword);
      return Response.json({ changed: true, reset: true, mustChangePassword: false }, { headers: { "Set-Cookie": await adminSessionCookie(email, isSecureRequest(request)), "Cache-Control": "no-store" } });
    }

    await changeAdminPassword(email, currentPassword, newPassword);
    return Response.json({ changed: true, reset: false, mustChangePassword: false }, { headers: { "Set-Cookie": await adminSessionCookie(email, isSecureRequest(request)), "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Password could not be reset." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const secure = isSecureRequest(request);
  return Response.json({ authenticated: false }, { headers: { "Set-Cookie": clearAdminSessionCookie(secure), "Cache-Control": "no-store" } });
}
