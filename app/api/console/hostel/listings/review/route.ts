import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listHostelListingsForStaff, reviewHostelRoomListings } from "@/lib/hostel-engine/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The hostel review queue. `PENDING_REVIEW` is what needs a decision;
 * `APPROVED` is what is live and can be pulled if a complaint arrives.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const requested = (new URL(request.url).searchParams.get("status") || "PENDING_REVIEW").toUpperCase();
    const status = requested === "APPROVED" ? "APPROVED" : "PENDING_REVIEW";
    return Response.json({ ok: true, status, listings: await listHostelListingsForStaff(status) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/** Room/year decisions; bulk approval is deliberately administrator-only. */
export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { action?: string; scope?: string; roomId?: string; periodId?: string; reason?: string; expectedListingIds?: string[] };
    const action = String(body.action || "").toUpperCase();
    const all = body.scope === "ALL";
    if (!["APPROVE","REJECT","SUSPEND"].includes(action) || (all && action !== "APPROVE")) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid room review action.", 400);
    }
    const roles = all || action === "SUSPEND" ? (["ADMIN"] as const) : (["ADMIN","MODERATOR"] as const);
    const account = await requireConsoleRole(request, roles);
    const limited = await rateLimit(request, "hostel-review", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (!Array.isArray(body.expectedListingIds) || !body.expectedListingIds.length || body.expectedListingIds.length > 5000) {
      throw new CampusEngineError("VALIDATION_ERROR", "Refresh the queue before reviewing these rooms.", 400);
    }
    const review = await reviewHostelRoomListings({
      action: action as "APPROVE" | "REJECT" | "SUSPEND", actor: account.email, all,
      roomId: body.roomId, periodId: body.periodId, reason: body.reason, expectedListingIds: body.expectedListingIds,
    });
    return Response.json({ ok: true, review }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
