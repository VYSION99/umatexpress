import { CONSOLE_ROLES, requireConsoleRole } from "@/lib/console-auth";
import { consoleAssistantReply } from "@/lib/console-assistant";
import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

type HistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * A short conversation with the console assistant. The role comes from the
 * signed session and decides the tool list; the body only carries words. The
 * latest turns are echoed back by the browser so the assistant can follow a
 * thread, and nothing in them is trusted beyond the words themselves.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, CONSOLE_ROLES);
    const limited = await rateLimit(request, "console-assistant", { limit: 30, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as { message?: unknown; history?: unknown; page?: unknown };
    const message = String(body.message || "").trim().slice(0, 1_500);
    if (!message) return Response.json({ error: "Ask the assistant something first." }, { status: 400, headers: NO_STORE });

    const history: HistoryTurn[] = (Array.isArray(body.history) ? body.history : [])
      .slice(-8)
      .flatMap((turn): HistoryTurn[] => {
        if (!turn || typeof turn !== "object") return [];
        const record = turn as Record<string, unknown>;
        const role = record.role === "assistant" ? "assistant" : record.role === "user" ? "user" : null;
        const content = String(record.content || "").trim().slice(0, 1_500);
        return role && content ? [{ role, content }] : [];
      });

    const page = String(body.page || "").trim().slice(0, 120);
    const result = await consoleAssistantReply({ request, account, message, history, page });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
