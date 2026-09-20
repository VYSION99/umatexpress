import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listPlatformSettings, setPlatformSetting } from "@/lib/platform-settings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The platform switchboard. Admin only: these switches decide whether the
 * scheduled jobs may move money unattended, so the same role that records a
 * transfer by hand is the role that turns the automation on.
 *
 * The environment variable stays as the fallback; a value saved here overrides
 * it, and every write is audited against the administrator who made it.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "console-settings-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return Response.json({ ok: true, settings: await listPlatformSettings() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "console-settings-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { key?: unknown; enabled?: unknown };
    const setting = await setPlatformSetting({ key: body.key, enabled: body.enabled, actor: account.email });
    return Response.json({ ok: true, setting }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
