import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { listEventsForConsole, moderateCinemaEvent } from "@/lib/cinema-engine/events";
import { requireConsoleRole } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * List all Cinema events for staff console inspection.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-console-events", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const offset = Math.max(0, Math.min(100_000, Math.floor(Number(url.searchParams.get("offset")) || 0)));
    const events = await listEventsForConsole({
      status: url.searchParams.get("status"),
      q: url.searchParams.get("q"),
      limit: 26,
      offset,
    });
    const page = events.slice(0, 25);
    return Response.json({
      ok: true,
      events: page,
      hasMore: events.length > 25,
      offset,
      summary: {
        listed: page.length,
        published: page.filter((e) => e.status === "PUBLISHED").length,
        cancelled: page.filter((e) => e.status === "CANCELLED").length,
      },
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/**
 * Moderate an event (CANCEL or UNPUBLISH).
 */
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-console-write", { limit: 120, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { id?: unknown; action?: unknown; reason?: unknown };
    const id = String(body.id || "").trim();
    const action = String(body.action || "").trim().toUpperCase();
    if (!id || (action !== "CANCEL" && action !== "UNPUBLISH")) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose an event and action (CANCEL or UNPUBLISH).", 400);
    }
    const result = await moderateCinemaEvent({
      id,
      action: action as "CANCEL" | "UNPUBLISH",
      actor: account.email,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return Response.json({ ok: true, result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
