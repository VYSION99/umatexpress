import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { readCinemaChatHistory } from "@/lib/cinema-engine/chat-history";
import { requireCinemaAccount } from "@/lib/student-auth";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const cursor = (name: string) => {
      const raw = params.get(name); if (raw === null) return undefined;
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid chat history cursor.", 400);
      return value;
    };
    const before = cursor("before"), after = cursor("after"), through = cursor("through");
    if (before !== undefined && after !== undefined) throw new CampusEngineError("VALIDATION_ERROR", "Choose one chat history direction.", 400);
    const threadId = params.get("thread") || undefined;
    if (threadId && !/^[A-Za-z0-9-]{1,80}$/.test(threadId)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid thread.", 400);
    return ok(await readCinemaChatHistory({ roomId: id, studentId: account.id, before, after, through, threadId }), { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
