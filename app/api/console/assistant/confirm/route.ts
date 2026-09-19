import { CONSOLE_ROLES, requireConsoleRole } from "@/lib/console-auth";
import { executeConsoleAssistantAction } from "@/lib/console-assistant";
import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The moment a proposed action becomes real. The token was signed by this
 * server when the assistant proposed the action, so it cannot be edited in the
 * browser; the role is re-read from the signed session, so a token cannot be
 * replayed by another account or role.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, CONSOLE_ROLES);
    const limited = await rateLimit(request, "console-assistant-action", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as { token?: unknown };
    const token = String(body.token || "");
    if (!token) return Response.json({ error: "Nothing to confirm." }, { status: 400, headers: NO_STORE });

    const outcome = await executeConsoleAssistantAction({ request, account, token });
    return Response.json({ ok: true, ...outcome }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
