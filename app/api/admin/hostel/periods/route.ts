import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { closeHostelPeriod, createHostelPeriod, listHostelPeriods } from "@/lib/hostel-engine/periods";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The academic-year catalogue is an administrator's to keep. */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    return Response.json({ ok: true, periods: await listHostelPeriods({ includeInactive: true }) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-review", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const period = await createHostelPeriod(account.email, body);
    return Response.json({ ok: true, period }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/** Closing a year stops new listings; the listings it already holds stay live. */
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-review", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { periodId?: string; action?: string };
    if (String(body.action || "").toUpperCase() !== "CLOSE") {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose close to retire an academic year.", 400);
    }
    const period = await closeHostelPeriod(account.email, String(body.periodId || ""));
    return Response.json({ ok: true, period }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
