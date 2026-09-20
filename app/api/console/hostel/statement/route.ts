import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { getHostelPayoutAccount, hostelPayoutStatement } from "@/lib/hostel-engine/payouts";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The landlord's own money: what each paid booking earned after the platform's
 * 3%, which entries have left their release window, and the batches already
 * transferred. A delegate manager sees the same statement, because it is the
 * landlord's money either way; only changing the account is owner-only.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const [statement, payoutAccount] = await Promise.all([
      hostelPayoutStatement(host.landlordId),
      getHostelPayoutAccount(host.landlordId),
    ]);
    return Response.json({ ok: true, isOwner: host.isOwner, account: payoutAccount, ...statement }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
