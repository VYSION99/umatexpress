import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getHostelPropertyDetail, landlordIdFromAccount, updateHostelProperty } from "@/lib/hostel-engine/landlord";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** One property with its rooms and beds, scoped to the signed-in landlord. */
export async function GET(request: Request, context: { params: Promise<{ propertyId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const { propertyId } = await context.params;
    const detail = await getHostelPropertyDetail(landlordIdFromAccount(account), String(propertyId || ""));
    return Response.json({ ok: true, ...detail }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ propertyId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { propertyId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const property = await updateHostelProperty(landlordIdFromAccount(account), String(propertyId || ""), body);
    return Response.json({ ok: true, property }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
