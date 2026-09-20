import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole, type ConsoleAccount } from "@/lib/console-auth";
import { createHostelProperty, getHostelLandlord, listHostelProperties } from "@/lib/hostel-engine/landlord";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The landlord's own workspace. The landlord id always comes from the signed
 * session's profile — never from the body or a query parameter — so one
 * landlord can never read or write another's rows.
 */
function landlordIdFor(account: ConsoleAccount) {
  if (!account.profileId) {
    throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to a landlord profile.", 401);
  }
  return account.profileId;
}

export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const landlordId = landlordIdFor(account);
    const [landlord, properties] = await Promise.all([
      getHostelLandlord(landlordId),
      listHostelProperties(landlordId),
    ]);
    return Response.json({ ok: true, landlord, properties }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-property-write", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const landlordId = landlordIdFor(account);
    const body = await request.json() as Record<string, unknown>;
    const property = await createHostelProperty(landlordId, body);
    return Response.json({ ok: true, property }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
