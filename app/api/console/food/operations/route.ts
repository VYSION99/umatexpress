import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { saveVendorFoodOperations, vendorFoodOperations } from "@/lib/food/operations";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin Food operation refused.", 403);
}
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["VENDOR"]);
    return Response.json(await vendorFoodOperations(account.profileId), { headers });
  } catch (error) {
    const failure = campusErrorPayload(error);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    const account = await requireConsoleRole(request, ["VENDOR"]);
    const limited = await rateLimit(request, "food-vendor-operations", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    return Response.json({ ok: true, operations: await saveVendorFoodOperations(account.profileId, account.id, account.email, body) }, { headers });
  } catch (error) {
    const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the operational update.", 400) : error);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
