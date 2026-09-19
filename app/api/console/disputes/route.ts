import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listDisputes, listOrganizerDisputes, openDispute, resolveDispute } from "@/lib/disputes";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Disputes in the console. A moderator and an organizer both reach this route
 * and see different things: the organizer sees the disputes about their own
 * trips, while the triage list and every decision belong to an administrator.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR", "ORGANIZER"]);
    if (account.role === "ORGANIZER") {
      if (!account.profileId) throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
      return Response.json({ ok: true, disputes: await listOrganizerDisputes(account.profileId), counts: {} }, { headers: NO_STORE });
    }
    if (account.role === "MODERATOR") {
      // A moderator may read the queue but may not decide it, so the console
      // shows them what is waiting without offering the resolution controls.
      const { disputes, counts } = await listDisputes({ status: String(new URL(request.url).searchParams.get("status") || "") });
      return Response.json({ ok: true, disputes, counts, readOnly: true }, { headers: NO_STORE });
    }
    const { disputes, counts } = await listDisputes({ status: String(new URL(request.url).searchParams.get("status") || "") });
    return Response.json({ ok: true, disputes, counts }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "RESOLVE").trim().toUpperCase();

    if (action === "OPEN") {
      const account = await requireConsoleRole(request, ["ADMIN", "ORGANIZER"]);
      if (account.role === "ORGANIZER" && !account.profileId) {
        throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
      }
      const limited = await rateLimit(request, "organizer-dispute", { limit: 10, windowMs: 60 * 60_000 });
      if (!limited.ok) return rateLimitResponse(limited.retryAfter);
      const dispute = await openDispute({
        raisedByRole: "ORGANIZER",
        raisedBy: account.role === "ORGANIZER" ? String(account.profileId) : String(account.email),
        contact: String(account.email || ""),
        bookingReference: body.bookingReference,
        tripId: body.tripId,
        category: body.category,
        subject: body.subject,
        details: body.details,
      });
      return Response.json({ ok: true, dispute }, { status: 201, headers: NO_STORE });
    }

    if (action !== "RESOLVE") throw new CampusEngineError("VALIDATION_ERROR", "Unknown dispute action.", 400);
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const result = await resolveDispute({
      disputeId: String(body.disputeId || ""),
      status: body.status,
      resolution: body.resolution,
      note: body.note,
      actor: String(account.email || ""),
    });
    return Response.json({ ok: true, dispute: result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
