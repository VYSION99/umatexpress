import { adminAuthConfigStatus, adminSessionCookie, clearAdminSessionCookie, isSecureRequest, validateAdminCredentials } from "@/lib/admin-auth";
import { adminMustChangePassword, changeAdminPassword } from "@/lib/admin-credentials";
import { clearConsoleSessionCookie, consoleSessionCookie } from "@/lib/console-auth";
import { changeConsolePassword } from "@/lib/console-signin";
import { staffSessionFromRequest } from "@/lib/staff-session";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";

export async function GET(request: Request) {
  // Reports the staff session, whether it came from the console identity or
  // from the legacy admin cookie, so one gate serves every admin screen.
  const staff = await staffSessionFromRequest(request);
  if (staff) {
    const mustChangePassword = staff.source === "legacy" ? await adminMustChangePassword(staff.email) : staff.mustChangePassword;
    return Response.json({ authenticated: true, email: staff.email, role: staff.role, source: staff.source, mustChangePassword, config: await adminAuthConfigStatus() }, { headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ authenticated: false, email: null, mustChangePassword: false, config: await adminAuthConfigStatus() }, { status: 401, headers: { "Cache-Control": "no-store" } });
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
  const staff = await staffSessionFromRequest(request);
  if (!staff) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    const limited = await rateLimit(request, "admin-password-change", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { mode?: "reset" | "change"; currentPassword?: string; newPassword?: string };
    const mode = body.mode === "reset" ? "reset" : "change";
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");

    if (staff.source === "console" && staff.account) {
      await changeConsolePassword(staff.account, currentPassword, newPassword);
      return Response.json(
        { changed: true, reset: mode === "reset", mustChangePassword: false },
        { headers: { "Set-Cookie": await consoleSessionCookie(staff.account, request), "Cache-Control": "no-store" } },
      );
    }

    const email = staff.email;

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
  // Clearing both cookies is deliberate: signing out on the console origin must
  // end whichever of the two sessions is in play.
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearAdminSessionCookie(secure));
  headers.append("Set-Cookie", clearConsoleSessionCookie(request));
  return Response.json({ authenticated: false }, { headers });
}
