import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { cinemaRoomNamespace } from "@/lib/cloudflare-bindings";
import { requireCinemaAccount } from "@/lib/student-auth";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(request: Request, context: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-chat-seek", account.id, { limit: 30, windowMs: 60000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id, messageId } = await context.params;
    const namespace = await cinemaRoomNamespace();
    if (!namespace) throw new CampusEngineError("CONFIG_REQUIRED", "Live playback is unavailable.", 503);
    const response = await namespace.get(namespace.idFromName(id)).fetch("https://cinema-room/chat-seek", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: id, studentId: account.id, messageId }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new CampusEngineError("INVALID_STATE", data.error || "The reference could not be opened.", response.status);
    return ok(data, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
