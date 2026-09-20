import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { listHostelPlugins, listLandlordPluginSubscriptions, startPluginSubscription } from "@/lib/hostel-engine/plugins";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The services this landlord can switch on, and the ones already running.
 *
 * Subscribing is a platform payment: the landlord pays the catalogue price for
 * the academic year, and that fee sits beside the 9% commission on bed payments
 * rather than replacing it. The amount a resident pays is the landlord's own
 * number, defaulted from the catalogue's suggestion.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const [catalogue, subscriptions] = await Promise.all([
      listHostelPlugins(),
      listLandlordPluginSubscriptions(host.landlordId),
    ]);
    return Response.json({ ok: true, catalogue, subscriptions }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-plugin-subscribe", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { pluginId?: unknown; periodId?: unknown; propertyId?: unknown; residentPrice?: unknown };
    const pluginId = String(body.pluginId || "");
    if (!pluginId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a service to switch on.", 400);
    const host = await resolveHostelHost(account);
    const result = await startPluginSubscription({
      landlordId: host.landlordId,
      landlordEmail: account.email,
      pluginId,
      periodId: String(body.periodId || ""),
      propertyId: String(body.propertyId || ""),
      residentPrice: body.residentPrice === undefined ? undefined : Number(body.residentPrice),
      origin: new URL(request.url).origin,
    });
    return Response.json({ ok: true, ...result }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
