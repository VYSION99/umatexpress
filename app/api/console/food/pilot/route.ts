import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { foodOperationsDashboard, resolveFoodIssue, saveFoodPilotSettings, setProviderPilot } from "@/lib/food/operations";

const headers = { "Cache-Control": "no-store" };
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin pilot action refused.", 403);
}
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    return Response.json(await foodOperationsDashboard(), { headers });
  } catch (error) {
    const failure = campusErrorPayload(error);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "").toUpperCase();
    if (action === "GLOBAL") return Response.json({ ok: true, pilot: await saveFoodPilotSettings(body, account.email) }, { headers });
    if (action === "PROVIDER") return Response.json({ ok: true, provider: await setProviderPilot({ providerId: body.providerId, enabled: body.enabled }, account.email) }, { headers });
    if (action === "ISSUE") return Response.json({ ok: true, issue: await resolveFoodIssue({ ...body, action: body.caseAction }, account.email) }, { headers });
    throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid pilot action.", 400);
  } catch (error) {
    const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the pilot action.", 400) : error);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
