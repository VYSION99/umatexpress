import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { findCampusSeatWatch, watchCampusCorridor } from "@/lib/campus-engine/watch";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { studentAccountFromRequest } from "@/lib/student-auth";

/**
 * Asking to be told when a route has a seat.
 *
 * Open to a signed-in student and to a guest with an address, because the
 * moment a student wants this is the moment they are standing at a gate with
 * nothing live — and making them sign in first is how a wish becomes a lost
 * booking. A signed-in account always wins: the address that gets the mail is
 * the account's own.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-watch-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const corridorId = url.searchParams.get("corridorId") || "";
    const account = await studentAccountFromRequest(request);
    const email = account?.email || url.searchParams.get("email") || "";
    const watch = await findCampusSeatWatch(corridorId, email);
    return ok({ watching: Boolean(watch?.active) && !watch?.notifiedAt, watch }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-watch-write", { limit: 30, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json().catch(() => ({})) as { corridorId?: string; email?: string; name?: string; phone?: string; source?: string };
    if (!String(body.corridorId || "").trim()) throw new CampusEngineError("VALIDATION_ERROR", "Choose the route you want to hear about.", 400);
    const account = await studentAccountFromRequest(request);
    const watch = await watchCampusCorridor({
      corridorId: body.corridorId,
      email: account?.email || body.email,
      name: account?.name || body.name,
      phone: account?.phone || body.phone,
      source: account ? "account" : String(body.source || "board"),
    });
    return ok({ watching: true, watch }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
