import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { onboardingReviewQueue, reviewOwnerStep } from "@/lib/hostel-engine/onboarding";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const NO_STORE = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    return Response.json({ ok: true, ...await onboardingReviewQueue() }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-onboarding-review", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { landlordId?: string; step?: string; action?: string; reason?: string };
    if (!body.landlordId || !["PROFILE", "IDENTITY", "PAYOUT"].includes(body.step || "") || !["APPROVE", "REJECT"].includes(body.action || "")) throw new CampusEngineError("VALIDATION_ERROR", "Choose an owner, review step and decision.", 400);
    const owner = await reviewOwnerStep({ landlordId: body.landlordId, step: body.step as "PROFILE" | "IDENTITY" | "PAYOUT", action: body.action as "APPROVE" | "REJECT", reason: body.reason, actor: account.email });
    return Response.json({ ok: true, owner }, { headers: NO_STORE });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
