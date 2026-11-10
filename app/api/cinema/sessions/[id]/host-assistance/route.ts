import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { applyCinemaHostAssistance, changeCinemaHostAssistance, listCinemaHostAssistance, requestCinemaHostAssistance } from "@/lib/cinema-engine/host-assistance";
import { assertCinemaPrivateAccount, nudgeCinemaPrivateStudy } from "@/lib/cinema-engine/private-study";
import type { CinemaChatMessage } from "@/lib/cinema-engine/protocol";
import { announceCinemaChatRefresh, announceCinemaInteraction } from "@/lib/cinema-engine/realtime";
import { requireCinemaAccount } from "@/lib/student-auth";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";
const HEADERS = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    return ok(await listCinemaHostAssistance(id, account.id), { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    const limited = await rateLimitSubject("cinema-host-assistant", account.id, { limit: 12, windowMs: 3600000 }); if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const draft = await requestCinemaHostAssistance({ roomId: id, ownerId: account.id, requestId: String(body.requestId || ""), kind: body.kind, brief: body.brief, linkVideo: body.linkVideo !== false, video: body.video as CinemaChatMessage["video"] });
    if (draft.status === "QUEUED") await nudgeCinemaPrivateStudy(draft.id, id).catch(() => undefined);
    return ok({ draft }, { status: 202, headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const limited = await rateLimitSubject(body.action === "RETRY" ? "cinema-host-assistant" : "cinema-host-review", account.id, body.action === "RETRY" ? { limit: 12, windowMs: 3600000 } : { limit: 30, windowMs: 60000 }); if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const input = { roomId: id, ownerId: account.id, id: String(body.requestId || "") };
    if (body.action === "APPLY") {
      const result = await applyCinemaHostAssistance({ ...input, displayName: account.name, question: body.question, options: body.options, text: body.text, itemIndex: body.itemIndex });
      if (result.kind === "POLL") await announceCinemaInteraction(id, "polls"); else await announceCinemaChatRefresh(id);
      return ok({ result }, { headers: HEADERS }, request);
    }
    if (body.action !== "RETRY" && body.action !== "CANCEL" && body.action !== "DISMISS") throw new CampusEngineError("VALIDATION_ERROR", "Choose retry, cancel, dismiss or apply.", 400);
    const result = await changeCinemaHostAssistance({ ...input, action: body.action });
    if ("draft" in result && result.draft.status === "QUEUED") await nudgeCinemaPrivateStudy(input.id, id).catch(() => undefined);
    return ok(result, { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
