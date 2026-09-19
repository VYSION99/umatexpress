import { CONSOLE_ROLES, requireConsoleRole } from "@/lib/console-auth";
import { consoleBriefFor } from "@/lib/console-assistant";
import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The daily brief: what needs the signed-in role's attention, read now from
 * the same library functions the console pages use. It never calls a model,
 * so the card on screen and the assistant's daily_brief tool hold identical
 * numbers, and a section that cannot be read is reported as missing instead
 * of failing the whole brief.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, CONSOLE_ROLES);
    const limited = await rateLimit(request, "console-assistant-brief", { limit: 60, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const brief = await consoleBriefFor({ request, account });
    return Response.json({ ok: true, ...brief }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
