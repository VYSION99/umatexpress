import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { curiosityCatalog } from "@/lib/curiosity/catalog";
import { curiosityGoalParserEnabled, interpretCuriosityGoalAsync } from "@/lib/curiosity/interpreter";
import { curiosityCandidateIds, decideCuriosity, type CuriosityInput, type CuriosityPathStep } from "@/lib/curiosity/policy";
import { curiosityReadiness } from "@/lib/curiosity/readiness";
import { curiosityCohortInvitation, curiosityCohortNonce, issueCuriosityFeedbackToken } from "@/lib/curiosity/pilot-access";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { logEvent } from "@/lib/observability";

const headers = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 2048;

async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Choose a shorter discovery request.", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new CampusEngineError("VALIDATION_ERROR", "Choose a discovery goal.", 400);
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Choose a shorter discovery request.", 400);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function validServiceIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 12
    && value.every((id) => typeof id === "string" && id.length <= 40);
}

export async function GET(request: Request) {
  try {
    const invitation = await curiosityCohortInvitation(request);
    return Response.json({ enabled: invitation.enabled }, { headers: { ...headers, ...(invitation.cookie ? { "Set-Cookie": invitation.cookie } : {}) } });
  } catch {
    logEvent("error", "curiosity_invitation_failed", {});
    return Response.json({ enabled: false }, { headers });
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin discovery request refused.", 403);
    const cohortNonce = await curiosityCohortNonce(request);
    if (!cohortNonce) throw new CampusEngineError("NOT_FOUND", "Guided discovery is not available.", 404);
    const limited = await rateLimitSubject("curiosity-decision", cohortNonce, { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await boundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a discovery goal.", 400);
    const data = body as Record<string, unknown>;

    let resolvedIntent: string | undefined;
    let resolvedIntents: string[] | undefined;
    let inferredTravelChoice: string | undefined;

    if (data.intents !== undefined) {
      if (!Array.isArray(data.intents) || data.intents.length === 0 || data.intents.length > 3 || data.intents.some((item) => typeof item !== "string" || item.length > 24)) {
        throw new CampusEngineError("VALIDATION_ERROR", "Choose up to three discovery goals.", 400);
      }
      resolvedIntents = data.intents as string[];
    } else if (data.intent !== undefined) {
      if (typeof data.intent !== "string" || data.intent.length === 0 || data.intent.length > 24) {
        throw new CampusEngineError("VALIDATION_ERROR", "Choose a discovery goal.", 400);
      }
      resolvedIntent = data.intent;
    } else if (typeof data.goal === "string" && data.goal.trim().length > 0 && data.goal.length <= 120 && await curiosityGoalParserEnabled()) {
      const parsed = await interpretCuriosityGoalAsync(data.goal);
      resolvedIntents = parsed.intents;
      inferredTravelChoice = parsed.travelChoice;
    } else {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose a discovery goal.", 400);
    }

    if (data.travelChoice !== undefined && !["campus", "home"].includes(String(data.travelChoice))) throw new CampusEngineError("VALIDATION_ERROR", "Choose a travel direction.", 400);
    if (data.hiddenServiceIds !== undefined && !validServiceIdList(data.hiddenServiceIds)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid service preferences.", 400);
    if (data.suppressedServiceIds !== undefined && !validServiceIdList(data.suppressedServiceIds)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid service preferences.", 400);
    if (data.questionsAsked !== undefined && (data.questionsAsked !== 0 && data.questionsAsked !== 1)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid question count.", 400);

    const input: CuriosityInput = {
      intent: resolvedIntent,
      intents: resolvedIntents,
      travelChoice: (data.travelChoice as string | undefined) ?? inferredTravelChoice,
      hiddenServiceIds: data.hiddenServiceIds as string[] | undefined,
      suppressedServiceIds: data.suppressedServiceIds as string[] | undefined,
      questionsAsked: data.questionsAsked as number | undefined,
    };
    const catalog = curiosityCatalog();
    const ids = new Set(curiosityCandidateIds(input));
    const readiness = ids.size ? await curiosityReadiness(catalog.filter((item) => ids.has(item.id))) : [];
    const rawDecision = decideCuriosity(input, catalog, readiness);

    if (rawDecision.kind === "SUGGEST_PATH") {
      const steps = await Promise.all(rawDecision.steps.map(async (step) => ({
        ...step,
        feedbackToken: await issueCuriosityFeedbackToken(step.service.id, cohortNonce),
      }))) as [CuriosityPathStep, ...CuriosityPathStep[]];
      const decision = { ...rawDecision, steps };
      return Response.json({ decision, feedbackToken: steps[0].feedbackToken }, { headers });
    }

    const feedbackToken = rawDecision.kind === "SUGGEST" ? await issueCuriosityFeedbackToken(rawDecision.service.id, cohortNonce) : undefined;
    return Response.json({ decision: rawDecision, ...(feedbackToken ? { feedbackToken } : {}) }, { headers });
  } catch (error) {
    if (!(error instanceof CampusEngineError) && !(error instanceof SyntaxError)) logEvent("error", "curiosity_decision_failed", {});
    const safeError = error instanceof SyntaxError ? new CampusEngineError("VALIDATION_ERROR", "Choose a discovery goal.", 400)
      : error instanceof CampusEngineError ? error : new CampusEngineError("ENGINE_ERROR", "Guided discovery is temporarily unavailable.", 500);
    const failure = campusErrorPayload(safeError);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
