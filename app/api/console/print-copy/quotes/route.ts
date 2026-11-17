import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { requireConsoleRole } from "@/lib/console-auth";
import { listPrintCopyQuotes, updatePrintCopyQuote } from "@/lib/print-copy/directory";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const quotes = await listPrintCopyQuotes();
    await consoleAudit({ actor: account.email, action: "PRINT_COPY_QUOTES_READ", targetType: "print_copy_quote_queue", details: { count: quotes.length } });
    return Response.json({ quotes }, { headers });
  } catch (error) { const failure = campusErrorPayload(error); return Response.json(failure.body, { status: failure.status, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin quote update refused.", 403);
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { id?: unknown; status?: unknown; staffNote?: unknown };
    const quote = await updatePrintCopyQuote({ id: body.id, status: body.status, staffNote: body.staffNote });
    await consoleAudit({ actor: account.email, action: "PRINT_COPY_QUOTE_UPDATED", targetType: "print_copy_quote", targetReference: quote.id, details: { status: quote.status } });
    return Response.json({ ok: true, quote }, { headers });
  } catch (error) { const failure = campusErrorPayload(error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Enter the quote update.", 400) : error); return Response.json(failure.body, { status: failure.status, headers }); }
}
