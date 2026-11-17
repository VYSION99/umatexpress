import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { requireConsoleRole } from "@/lib/console-auth";
import { getPrintCopyQuoteSettings, setPrintCopyQuoteSettings } from "@/lib/print-copy/directory";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try { await requireConsoleRole(request, ["ADMIN"]); return Response.json({ settings: await getPrintCopyQuoteSettings() }, { headers }); }
  catch (error) { const failure = campusErrorPayload(error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function PUT(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin quote settings update refused.", 403);
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { enabled?: unknown; supportOwner?: unknown };
    const settings = await setPrintCopyQuoteSettings({ enabled: body.enabled, supportOwner: body.supportOwner }, account.email);
    await consoleAudit({ actor: account.email, action: "PRINT_COPY_QUOTES_SWITCH_UPDATED", targetType: "print_copy_settings", targetReference: "GLOBAL", details: { enabled: settings.enabled } });
    return Response.json({ ok: true, settings }, { headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the quote settings.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
