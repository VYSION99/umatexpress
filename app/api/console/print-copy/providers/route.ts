import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { requireConsoleRole } from "@/lib/console-auth";
import { decidePrintCopyProvider, listPrintCopyProvidersForStaff, savePrintCopyProvider } from "@/lib/print-copy/directory";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin Print & Copy action refused.", 403);
}
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    return Response.json({ providers: await listPrintCopyProvidersForStaff() }, { headers });
  } catch (error) { const failure = campusErrorPayload(error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "console-print-copy-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const provider = await savePrintCopyProvider(body, account.email);
    await consoleAudit({ actor: account.email, action: body.id ? "PRINT_COPY_PROVIDER_UPDATED" : "PRINT_COPY_PROVIDER_CREATED", targetType: "print_copy_provider", targetReference: provider.id });
    return Response.json({ ok: true, provider }, { status: body.id ? 200 : 201, headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the shop details.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "console-print-copy-write", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { id?: unknown; action?: unknown; note?: unknown };
    const provider = await decidePrintCopyProvider({ id: body.id, action: body.action, note: body.note }, account.email);
    await consoleAudit({ actor: account.email, action: `PRINT_COPY_PROVIDER_${String(body.action || "").toUpperCase()}`, targetType: "print_copy_provider", targetReference: provider.id, details: { status: provider.status } });
    return Response.json({ ok: true, provider }, { headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Choose a shop decision.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
