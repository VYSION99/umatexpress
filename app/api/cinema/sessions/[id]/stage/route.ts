import { fail, ok } from "@/lib/campus-engine/responses";
import { decideStageRequest, discussionAudienceState, requestStage, stageRequests, touchDiscussionAudience } from "@/lib/cinema-engine/stage-requests";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, context: Context) {
  try { const account = await requireCinemaAccount(request); const limited = await rateLimitSubject("cinema-stage-read", account.id, { limit: 30, windowMs: 60_000 }); if (!limited.ok) return rateLimitResponse(limited.retryAfter); const { id } = await context.params; return ok({ state: await discussionAudienceState(id, account.id), requests: await stageRequests(id, account.id) }, { headers: NO_STORE }, request); }
  catch (error) { return fail(error, request); }
}

export async function POST(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-stage-request", account.id, { limit: 3, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params; return ok(await requestStage({ id, studentId: account.id, displayName: account.name }), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function PUT(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-audience-heartbeat", account.id, { limit: 3, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    return ok(await touchDiscussionAudience(id, account.id), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-stage-decide", account.id, { limit: 40, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params; const body = await request.json() as { guestId?: unknown; action?: unknown };
    return ok(await decideStageRequest({ id, studentId: account.id, guestId: body.guestId, action: body.action }), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}
