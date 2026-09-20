import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { cancelPluginSubscription, getPluginSubscriptionByReference } from "@/lib/hostel-engine/plugins";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Abandoning an unpaid subscription window, so the landlord can start over. */
export async function DELETE(request: Request, context: { params: Promise<{ reference: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-plugin-subscribe", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { reference } = await context.params;
    const host = await resolveHostelHost(account);
    const subscription = await getPluginSubscriptionByReference(String(reference || ""));
    if (!subscription) throw new CampusEngineError("NOT_FOUND", "That subscription was not found.", 404);
    if (subscription.landlordId !== host.landlordId) {
      throw new CampusEngineError("FORBIDDEN", "That subscription belongs to another account.", 403);
    }
    const cancelled = await cancelPluginSubscription(subscription.reference);
    return Response.json({ ok: true, cancelled }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
