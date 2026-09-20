import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { decideHostelService, isHostelServiceAction, listServiceRequestsForLandlord } from "@/lib/hostel-engine/plugins";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The requests residents have made, oldest decision first. */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    return Response.json({ ok: true, requests: await listServiceRequestsForLandlord(host.landlordId) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/**
 * One endpoint for the whole decision, so the state machine has a single
 * definition in the engine: approve, decline, start, complete or cancel.
 */
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { requestId?: unknown; action?: unknown };
    const action = String(body.action || "").trim().toUpperCase();
    if (!isHostelServiceAction(action)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose approve, decline, start, complete or cancel.", 400);
    }
    const host = await resolveHostelHost(account);
    const service = await decideHostelService({
      landlordId: host.landlordId,
      requestId: String(body.requestId || ""),
      action,
      actor: account.email,
    });
    return Response.json({ ok: true, service }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
