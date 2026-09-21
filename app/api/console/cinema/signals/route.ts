import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listCinemaSignals, resolveCinemaSignal } from "@/lib/cinema-engine/signals";
import { requireConsoleRole } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The watch-report desk. Nothing here is raised by a rule: every card is a
 * student's report, folded per room or message while it is open, and a person
 * reads the evidence and records what they found.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-signals-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const status = String(new URL(request.url).searchParams.get("status") || "OPEN").toUpperCase();
    const signals = await listCinemaSignals({ status });
    return Response.json({
      ok: true,
      signals,
      summary: {
        open: signals.length,
        high: signals.filter((signal) => signal.severity === "HIGH").length,
        medium: signals.filter((signal) => signal.severity === "MEDIUM").length,
        low: signals.filter((signal) => signal.severity === "LOW").length,
      },
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-signals-write", { limit: 120, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { action?: unknown; signalId?: unknown; note?: unknown };
    const signal = await resolveCinemaSignal({
      signalId: body.signalId,
      action: body.action,
      note: body.note,
      actor: account.email,
    });
    return Response.json({ ok: true, signal }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
