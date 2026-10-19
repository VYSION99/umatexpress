import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { decideFoodProvider, listFoodProvidersForStaff, saveFoodProvider } from "@/lib/food/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin Food action refused.", 403);
}
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    return Response.json({ providers: await listFoodProvidersForStaff() }, { headers });
  } catch (error) { const failure = campusErrorPayload(error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "console-food-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    return Response.json({ ok: true, provider: await saveFoodProvider(body, account.email) }, { status: body.id ? 200 : 201, headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the provider details.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as { id?: unknown; action?: unknown; note?: unknown };
    return Response.json({ ok: true, provider: await decideFoodProvider({ id: body.id, action: body.action, note: body.note }, account.email) }, { headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Choose a provider decision.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
