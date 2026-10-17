import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { consoleAudit } from "@/lib/console-audit";
import { consoleSessionCookie, recordConsoleLogin, type ConsoleRole } from "@/lib/console-auth";
import { studentSessionCookie } from "@/lib/student-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  beginPasskeyRegistration, beginPasskeySignIn, finishPasskeyRegistration,
  finishPasskeySignIn, listPasskeys, removePasskey, type PasskeyScope,
} from "@/lib/passkeys";

function scope(value: unknown): PasskeyScope {
  if (value === "STUDENT" || value === "CONSOLE") return value;
  throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid account type.", 400);
}

export async function GET(request: Request) {
  try {
    const selected = scope(new URL(request.url).searchParams.get("scope"));
    return ok({ passkeys: await listPasskeys(request, selected) }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "auth-passkeys", { limit: 20, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as {
      scope?: unknown; action?: string; password?: string; challengeId?: string;
      response?: RegistrationResponseJSON | AuthenticationResponseJSON;
    };
    const selected = scope(body.scope);
    if (body.action === "register-options") return ok(await beginPasskeyRegistration(request, selected, String(body.password || "")), { headers: { "Cache-Control": "no-store" } }, request);
    if (body.action === "register-verify" && body.response && body.challengeId) return ok(await finishPasskeyRegistration(request, selected, body.challengeId, body.response as RegistrationResponseJSON), { headers: { "Cache-Control": "no-store" } }, request);
    if (body.action === "signin-options") return ok(await beginPasskeySignIn(request, selected), { headers: { "Cache-Control": "no-store" } }, request);
    if (body.action === "signin-verify" && body.response && body.challengeId) {
      const account = await finishPasskeySignIn(request, selected, body.challengeId, body.response as AuthenticationResponseJSON);
      if (selected === "STUDENT") return ok({ authenticated: true }, { headers: { "Set-Cookie": await studentSessionCookie(account.id, request), "Cache-Control": "no-store" } }, request);
      await recordConsoleLogin(account.id);
      await consoleAudit({ actor: account.email, action: "CONSOLE_SIGN_IN", targetType: "console_account", targetReference: account.id, details: { method: "PASSKEY" } }).catch(() => undefined);
      return ok({ authenticated: true }, { headers: { "Set-Cookie": await consoleSessionCookie({ id: account.id, role: (account as { role: ConsoleRole }).role }, request), "Cache-Control": "no-store" } }, request);
    }
    throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid passkey action.", 400);
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: Request) {
  try {
    const limited = await rateLimit(request, "auth-passkey-remove", { limit: 6, windowMs: 15 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { scope?: unknown; id?: string; password?: string };
    if (!body.id) throw new CampusEngineError("VALIDATION_ERROR", "Choose a passkey to remove.", 400);
    const selected = scope(body.scope);
    const removed = await removePasskey(request, selected, body.id, String(body.password || ""));
    const cookie = selected === "STUDENT"
      ? await studentSessionCookie(removed.accountId, request)
      : await consoleSessionCookie({ id: removed.accountId, role: removed.role as ConsoleRole }, request);
    return ok({ removed: true }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
