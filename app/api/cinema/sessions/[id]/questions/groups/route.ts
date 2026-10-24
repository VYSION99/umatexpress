import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { listDiscussionQuestions } from "@/lib/cinema-engine/questions";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { callIntelligence } from "@/lib/intelligence-api";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

/** A host-only, read-only suggestion. Python never sees room membership or decides visibility. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: account.id });
    if (!room.isMember || !["HOST", "COHOST"].includes(room.currentRole)) {
      throw new CampusEngineError("FORBIDDEN", "Only the host or a co-host can review question groups.", 403);
    }
    const limited = await rateLimitSubject("cinema-question-groups", account.id, { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const questions = (await listDiscussionQuestions(id, account.id))
      .filter((question) => question.status === "PENDING" || question.status === "APPROVED")
      .slice(0, 100);
    if (questions.length < 2) return ok({ groups: [] }, { headers: { "Cache-Control": "no-store" } }, request);
    let result: { groups: string[][] };
    try {
      result = await callIntelligence<{ groups: string[][] }>("/v1/cinema/questions/groups", {
        questions: questions.map(({ id: questionId, text }) => ({ id: questionId, text })),
      }, 5000);
    } catch {
      throw new CampusEngineError("CONFIG_REQUIRED", "Question suggestions are temporarily unavailable. The question queue still works.", 503);
    }
    const known = new Set(questions.map((question) => question.id));
    const seen = new Set<string>();
    const groups = Array.isArray(result.groups) ? result.groups.slice(0, 30).map((group) =>
      Array.isArray(group) ? group.filter((questionId) => {
        if (typeof questionId !== "string" || !known.has(questionId) || seen.has(questionId)) return false;
        seen.add(questionId);
        return true;
      }).slice(0, 20) : [],
    ).filter((group) => group.length > 1) : [];
    return ok({ groups }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
