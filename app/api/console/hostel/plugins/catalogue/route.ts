import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listHostelPluginsForStaff, saveHostelPlugin } from "@/lib/hostel-engine/plugins";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The platform's own catalogue. Only an administrator sets these prices,
 * because the same price is charged to every landlord on the platform;
 * landlords read the same rows through /api/console/hostel/plugins.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return Response.json({ ok: true, catalogue: await listHostelPluginsForStaff() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/** Create with a code, or edit with a pluginId. Both land in the audit log. */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-plugin-catalogue", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    if (body.price !== undefined && (!Number.isFinite(Number(body.price)) || Number(body.price) < 0)) {
      throw new CampusEngineError("VALIDATION_ERROR", "The platform price must be a whole number of pesewas.", 400);
    }
    const plugin = await saveHostelPlugin({ ...body, actor: account.email });
    return Response.json({ ok: true, plugin }, { status: body.pluginId ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
