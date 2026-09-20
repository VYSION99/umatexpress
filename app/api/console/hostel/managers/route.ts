import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assertHostelOwner, inviteHostelManager, listHostelManagers, resolveHostelHost } from "@/lib/hostel-engine/managers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** A manager may see who else runs the buildings; only the owner may change it. */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    return Response.json({ ok: true, managers: await listHostelManagers(host.landlordId), isOwner: host.isOwner }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/**
 * Appointing a delegate is the owner's call alone. The invited person signs in
 * on the same console at the same address; `profile_id` is what points their
 * account at this landlord, so every existing hostel route keeps working.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-manager", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const body = await request.json() as Record<string, unknown>;
    const manager = await inviteHostelManager({
      landlordId: host.landlordId,
      actorEmail: account.email,
      name: body.name,
      email: body.email,
      phone: body.phone,
      password: body.password,
    });
    return Response.json({ ok: true, manager }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
