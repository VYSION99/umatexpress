import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { landlordIdFromAccount } from "@/lib/hostel-engine/landlord";
import { createHostelListing, listHostelListingsForProperty } from "@/lib/hostel-engine/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** A landlord's listings for one of their own properties. */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || "";
    if (!propertyId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a property.", 400);
    const listings = await listHostelListingsForProperty(landlordIdFromAccount(account), propertyId);
    return Response.json({ ok: true, listings }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const listing = await createHostelListing(landlordIdFromAccount(account), body);
    return Response.json({ ok: true, listing }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
