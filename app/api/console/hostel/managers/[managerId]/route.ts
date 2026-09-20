import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assertHostelOwner, resolveHostelHost, revokeHostelManager } from "@/lib/hostel-engine/managers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Revoking a manager suspends the console account that was pointed at this
 * landlord and drops its sessions, so access ends at the moment of the click.
 */
export async function DELETE(request: Request, context: { params: Promise<{ managerId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-manager", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const { managerId } = await context.params;
    const result = await revokeHostelManager({ landlordId: host.landlordId, managerId: String(managerId || ""), actorEmail: account.email });
    return Response.json({ ok: true, managerId: result.managerId }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
