import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { removeHostelListing, updateHostelListing } from "@/lib/hostel-engine/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Reprice a listing, or withdraw one that has not been approved. */
export async function PATCH(request: Request, context: { params: Promise<{ listingId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { listingId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const listing = await updateHostelListing((await resolveHostelHost(account)).landlordId, String(listingId || ""), body);
    return Response.json({ ok: true, listing }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ listingId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { listingId } = await context.params;
    if (!String(listingId || "").trim()) throw new CampusEngineError("VALIDATION_ERROR", "Choose a listing.", 400);
    const removed = await removeHostelListing((await resolveHostelHost(account)).landlordId, String(listingId || ""));
    return Response.json({ ok: true, ...removed }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
