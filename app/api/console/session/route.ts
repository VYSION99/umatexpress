import {
  clearConsoleSessionCookie,
  consoleAccountFromRequest,
  consoleSessionCookie,
  recordConsoleLogin,
  type ConsoleAccount,
} from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";
import { changeConsolePassword, resolveConsoleSignIn } from "@/lib/console-signin";
import { authGuardClear, authGuardFailure, authGuardStatus } from "@/lib/auth-guard";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** What a page may know about the signed-in account. Never includes secrets. */
function accountPayload(account: ConsoleAccount) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
    status: account.status,
    profileId: account.profileId,
  };
}

export async function GET(request: Request) {
  const account = await consoleAccountFromRequest(request);
  if (!account) {
    return Response.json({ authenticated: false }, { status: 401, headers: NO_STORE });
  }
  return Response.json(
    { authenticated: true, account: accountPayload(account), mustChangePassword: account.mustChangePassword === true },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "console-auth", { limit: 10, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as { email?: string; identifier?: string; password?: string };
    const identifier = String(body.email || body.identifier || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!identifier || !password) {
      return Response.json({ error: "Enter the email or phone number and password for this account." }, { status: 400, headers: NO_STORE });
    }

    const lock = await authGuardStatus("console-login", identifier);
    if (lock.locked) return rateLimitResponse(lock.retryAfter);

    const result = await resolveConsoleSignIn(identifier, password);
    if (!result) {
      const failure = await authGuardFailure("console-login", identifier);
      return Response.json(
        { error: failure.locked ? "Too many failed sign-in attempts. Try again later." : "Those console details did not match an active account." },
        { status: failure.locked ? 429 : 401, headers: NO_STORE },
      );
    }

    await authGuardClear("console-login", identifier);
    await recordConsoleLogin(result.account.id);
    await consoleAudit({
      actor: result.account.email,
      action: "CONSOLE_SIGN_IN",
      targetType: "console_account",
      targetReference: result.account.id,
      details: { role: result.account.role, bridged: result.bridged },
    }).catch(() => undefined);

    return Response.json(
      {
        authenticated: true,
        account: accountPayload(result.account),
        mustChangePassword: result.mustChangePassword,
      },
      {
        headers: {
          "Set-Cookie": await consoleSessionCookie(result.account, request, { mustChangePassword: result.mustChangePassword, bridged: result.bridged }),
          ...NO_STORE,
        },
      },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Console sign-in failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * Changes the console password. The current password is required even though a
 * session already exists, so a stolen session cannot lock the owner out. A
 * bridged account becomes a real console account the moment this succeeds.
 */
export async function PATCH(request: Request) {
  try {
    const account = await consoleAccountFromRequest(request);
    if (!account) return Response.json({ error: "Sign in to the console to continue." }, { status: 401, headers: NO_STORE });

    const limited = await rateLimit(request, "console-password-change", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as { currentPassword?: string; newPassword?: string };
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!currentPassword || !newPassword) {
      return Response.json({ error: "Enter the current password and the new password." }, { status: 400, headers: NO_STORE });
    }

    await changeConsolePassword(account, currentPassword, newPassword);
    await consoleAudit({
      actor: account.email,
      action: "CONSOLE_PASSWORD_CHANGED",
      targetType: "console_account",
      targetReference: account.id,
      details: { role: account.role },
    }).catch(() => undefined);

    return Response.json(
      { changed: true, mustChangePassword: false },
      { headers: { "Set-Cookie": await consoleSessionCookie(account, request), ...NO_STORE } },
    );
  } catch (error) {
    const status = error instanceof Error && "status" in error ? Number((error as { status?: number }).status || 400) : 400;
    return Response.json({ error: error instanceof Error ? error.message : "The password could not be changed." }, { status, headers: NO_STORE });
  }
}

export async function DELETE(request: Request) {
  return Response.json({ signedOut: true }, { headers: { "Set-Cookie": clearConsoleSessionCookie(request), ...NO_STORE } });
}
