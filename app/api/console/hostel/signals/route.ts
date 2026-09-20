import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listHostelSignals, resolveHostelSignal, scanHostelSignals } from "@/lib/hostel-engine/signals";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The trust desk for hostel supply. A scan is a recomputation of the rules,
 * never an accusation: a person reads the evidence and either records what they
 * found or dismisses it.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-signals-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const status = String(new URL(request.url).searchParams.get("status") || "OPEN").toUpperCase();
    const signals = await listHostelSignals({ status });
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
    const limited = await rateLimit(request, "hostel-signals-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { action?: unknown; signalId?: unknown; note?: unknown };
    const action = String(body.action || "").trim().toUpperCase();
    if (action === "SCAN") return Response.json({ ok: true, result: await scanHostelSignals() }, { headers: NO_STORE });
    const signal = await resolveHostelSignal({ signalId: String(body.signalId || ""), action, note: body.note, actor: account.email });
    return Response.json({ ok: true, signal }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
