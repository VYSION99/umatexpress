import { fail, ok } from "@/lib/campus-engine/responses";
import { listDiscussionQuestions, moderateDiscussionQuestion, submitDiscussionQuestion } from "@/lib/cinema-engine/questions";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try { const account = await requireCinemaAccount(request); const limited = await rateLimitSubject("cinema-question-read", account.id, { limit: 20, windowMs: 60_000 }); if (!limited.ok) return rateLimitResponse(limited.retryAfter); const { id } = await context.params; return ok({ questions: await listDiscussionQuestions(id, account.id) }, { headers: NO_STORE }, request); }
  catch (error) { return fail(error, request); }
}

export async function POST(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-question", account.id, { limit: 4, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params; const body = await request.json() as { text?: unknown };
    return ok({ question: await submitDiscussionQuestion({ id, studentId: account.id, displayName: account.name, text: body.text }) }, { status: 201, headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-question-moderate", account.id, { limit: 40, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params; const body = await request.json() as { questionId?: unknown; status?: unknown };
    return ok(await moderateDiscussionQuestion({ id, studentId: account.id, questionId: body.questionId, status: body.status }), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}
