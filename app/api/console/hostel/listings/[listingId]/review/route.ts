import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { landlordIdFromAccount } from "@/lib/hostel-engine/landlord";
import { reviewHostelListing, submitHostelListing } from "@/lib/hostel-engine/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One endpoint for the whole listing decision, so the state machine has a single
 * definition. A landlord may only `SUBMIT` their own listing; `APPROVE` and
 * `REJECT` belong to a reviewer, and pulling a live bed (`SUSPEND`) is an
 * administrator's call, since students can currently see it.
 */
export async function PATCH(request: Request, context: { params: Promise<{ listingId: string }> }) {
  try {
    const body = await request.json() as { action?: string; reason?: string };
    const action = String(body.action || "").trim().toUpperCase();
    const { listingId } = await context.params;
    if (!["SUBMIT", "APPROVE", "REJECT", "SUSPEND"].includes(action)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose submit, approve, reject or suspend.", 400);
    }

    const roles = action === "SUBMIT"
      ? (["LANDLORD"] as const)
      : action === "SUSPEND"
        ? (["ADMIN"] as const)
        : (["ADMIN", "MODERATOR"] as const);
    const account = await requireConsoleRole(request, roles);
    const limited = await rateLimit(request, action === "SUBMIT" ? "hostel-write" : "hostel-review", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const listing = action === "SUBMIT"
      ? await submitHostelListing(landlordIdFromAccount(account), String(listingId || ""))
      : await reviewHostelListing({
        listingId: String(listingId || ""),
        action: action as "APPROVE" | "REJECT" | "SUSPEND",
        reason: body.reason,
        actor: account.email,
      });
    return Response.json({ ok: true, listing }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
