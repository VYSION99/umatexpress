import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { verifyPluginSubscriptionPayment } from "@/lib/hostel-engine/plugins";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Where Paystack drops the landlord back after paying for a plugin. The console
 * session is the authorisation, so a subscription is only ever settled onto the
 * account that started it.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-plugin-verify", { limit: 120, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing subscription reference.", 400);
    const host = await resolveHostelHost(account);
    const subscription = await verifyPluginSubscriptionPayment(host.landlordId, reference);
    return Response.json({ ok: true, subscription }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
