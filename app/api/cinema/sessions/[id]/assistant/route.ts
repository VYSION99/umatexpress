import { fail, ok } from "@/lib/campus-engine/responses";
import { cancelCinemaAssistant, listCinemaAssistantJobs, requestCinemaAssistant } from "@/lib/cinema-engine/chat-assistant";
import { cinemaRoomNamespace } from "@/lib/cloudflare-bindings";
import { requireCinemaAccount } from "@/lib/student-auth";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
const HEADERS = { "Cache-Control": "no-store" };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const account = await requireCinemaAccount(request); const { id } = await context.params;
    return ok(await listCinemaAssistantJobs(id, account.id), { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); const { id } = await context.params;
    const limited = await rateLimitSubject("cinema-assistant", account.id, { limit: 12, windowMs: 3600000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { messageId?: unknown; retry?: unknown };
    const job = await requestCinemaAssistant({ roomId: id, studentId: account.id, messageId: String(body.messageId || ""), retry: body.retry === true });
    if (job.status === "QUEUED") {
      try {
        const namespace = await cinemaRoomNamespace();
        await namespace?.get(namespace.idFromName(id)).fetch("https://cinema-room/assistant-run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: job.id, roomId: id }) });
      } catch { /* Durable cron recovery will nudge the persisted request. */ }
    }
    return ok({ job }, { status: 202, headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); const { id } = await context.params;
    const body = await request.json() as { messageId?: unknown };
    return ok({ job: await cancelCinemaAssistant({ roomId: id, studentId: account.id, messageId: String(body.messageId || "") }) }, { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
