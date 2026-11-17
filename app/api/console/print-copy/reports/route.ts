import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { requireConsoleRole } from "@/lib/console-auth";
import { listPrintCopyReports, resolvePrintCopyReport } from "@/lib/print-copy/directory";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try { await requireConsoleRole(request, ["ADMIN"]); return Response.json({ reports: await listPrintCopyReports() }, { headers }); }
  catch (error) { const failure = campusErrorPayload(error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin report update refused.", 403);
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { id?: unknown; action?: unknown; note?: unknown };
    const report = await resolvePrintCopyReport({ id: body.id, action: body.action, note: body.note }, account.email);
    await consoleAudit({ actor: account.email, action: `PRINT_COPY_REPORT_${String(body.action || "").toUpperCase()}D`, targetType: "print_copy_report", targetReference: report.id, details: { status: report.status } });
    return Response.json({ ok: true, report }, { headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the report decision.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
