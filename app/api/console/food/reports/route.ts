import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listFoodReports, resolveFoodReport } from "@/lib/food/listings";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    return Response.json({ reports: await listFoodReports() }, { headers });
  } catch (error) { const failure = campusErrorPayload(error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin Food action refused.", 403);
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as { id?: unknown; action?: unknown; note?: unknown };
    return Response.json({ ok: true, report: await resolveFoodReport({ id: body.id, action: body.action, note: body.note }, account.email) }, { headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter a report decision.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
