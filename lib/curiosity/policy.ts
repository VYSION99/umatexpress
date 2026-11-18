import { CURIOSITY_POLICY_VERSION, type CuriosityCapability, type CuriosityIntent, type CuriosityServiceId, type TravelChoice } from "./catalog";

export type CuriosityReadiness = { serviceId: CuriosityServiceId; eligible: boolean; reasonCode: string; checkedAt: string };
export type CuriosityPathStep = {
  service: { id: CuriosityServiceId; title: string; href: string };
  explanation: string;
  uncertaintyNote: string;
  feedbackToken?: string;
};
export type CuriosityInput = {
  intent?: CuriosityIntent | string;
  intents?: Array<CuriosityIntent | string>;
  travelChoice?: TravelChoice | string;
  hiddenServiceIds?: string[];
  suppressedServiceIds?: string[];
  questionsAsked?: number;
};
export type CuriosityDecision =
  | { kind: "SUGGEST"; service: { id: CuriosityServiceId; title: string; href: string }; explanation: string; partialDropReason?: string; reasonCode: "INTENT_MATCH"; policyVersion: string }
  | { kind: "SUGGEST_PATH"; steps: [CuriosityPathStep, ...CuriosityPathStep[]]; partialDropReason?: string; reasonCode: "PATH_MATCH"; policyVersion: string }
  | { kind: "ASK"; questionId: "TRAVEL_KIND"; question: string; options: Array<{ id: TravelChoice; label: string }>; reasonCode: "NEED_TRAVEL_KIND"; policyVersion: string }
  | { kind: "ABSTAIN"; reasonCode: "NO_GOAL" | "SENSITIVE_INTENT" | "NO_ELIGIBLE_SERVICE" | "QUESTION_SKIPPED"; policyVersion: string };

const targetByIntent: Partial<Record<CuriosityIntent, CuriosityServiceId>> = {
  housing: "hostels", food: "food", print: "print-copy", social: "cinema",
};
const sensitiveIntents = new Set(["health", "clinic", "counselling", "counseling", "finance", "financial-help"]);

export function normalizeCuriosityIntents(input: CuriosityInput): string[] {
  if (Array.isArray(input.intents) && input.intents.length > 0) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of input.intents) {
      const normalized = String(raw || "").trim().toLowerCase();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        list.push(normalized);
        if (list.length >= 3) break;
      }
    }
    if (list.length > 0) return list;
  }
  return [String(input.intent || "unknown").trim().toLowerCase() || "unknown"];
}

export function curiosityCandidateIds(input: CuriosityInput): CuriosityServiceId[] {
  const intents = normalizeCuriosityIntents(input);
  const candidates: CuriosityServiceId[] = [];
  for (const intent of intents) {
    if (intent === "travel") {
      const travelIds: CuriosityServiceId[] = input.travelChoice === "campus"
        ? ["campus"]
        : input.travelChoice === "home"
          ? ["vacation"]
          : ["campus", "vacation"];
      for (const id of travelIds) {
        if (!candidates.includes(id)) candidates.push(id);
      }
    } else {
      const target = targetByIntent[intent as CuriosityIntent];
      if (target && !candidates.includes(target)) candidates.push(target);
    }
  }
  return candidates;
}

/** Hard gates run before any selection; no score or caller-provided state can override them. */
export function decideCuriosity(input: CuriosityInput, catalog: CuriosityCapability[], readiness: CuriosityReadiness[]): CuriosityDecision {
  const base = { policyVersion: CURIOSITY_POLICY_VERSION };
  const intents = normalizeCuriosityIntents(input);
  if (intents.some((intent) => sensitiveIntents.has(intent))) {
    return { ...base, kind: "ABSTAIN", reasonCode: "SENSITIVE_INTENT" };
  }
  const hidden = new Set([...(input.hiddenServiceIds || []), ...(input.suppressedServiceIds || [])]);
  const ready = (id: CuriosityServiceId) => {
    const capability = catalog.find((item) => item.id === id);
    return Boolean(
      capability?.launched
      && capability.href.startsWith("/")
      && !capability.href.startsWith("//")
      && !hidden.has(id)
      && readiness.some((item) => item.serviceId === id && item.eligible),
    );
  };

  if (intents.length === 1) {
    const intent = intents[0];
    let target: CuriosityServiceId | null = null;
    if (intent === "travel") {
      if (input.travelChoice === "campus") target = "campus";
      else if (input.travelChoice === "home") target = "vacation";
      else {
        const campusReady = ready("campus");
        const homeReady = ready("vacation");
        if (!campusReady && !homeReady) return { ...base, kind: "ABSTAIN", reasonCode: "NO_ELIGIBLE_SERVICE" };
        if ( Number(input.questionsAsked || 0) >= 1) return { ...base, kind: "ABSTAIN", reasonCode: "QUESTION_SKIPPED" };
        if (campusReady && homeReady) {
          return {
            ...base,
            kind: "ASK",
            questionId: "TRAVEL_KIND",
            question: "Are you travelling around campus or heading home?",
            options: [{ id: "campus", label: "Around campus" }, { id: "home", label: "Heading home" }],
            reasonCode: "NEED_TRAVEL_KIND",
          };
        }
        target = campusReady ? "campus" : "vacation";
      }
    } else {
      target = targetByIntent[intent as CuriosityIntent] || null;
    }
    if (!target && intent !== "travel") return { ...base, kind: "ABSTAIN", reasonCode: "NO_GOAL" };
    if (!target || !ready(target)) return { ...base, kind: "ABSTAIN", reasonCode: "NO_ELIGIBLE_SERVICE" };
    const capability = catalog.find((item) => item.id === target)!;
    return {
      ...base,
      kind: "SUGGEST",
      service: { id: capability.id, title: capability.title, href: capability.href },
      explanation: capability.explanation,
      reasonCode: "INTENT_MATCH",
    };
  }

  // Multi-intent path orchestration (2..3 intents).
  const recognized = intents.filter((intent) => intent === "travel" || Boolean(targetByIntent[intent as CuriosityIntent]));
  if (recognized.length === 0) return { ...base, kind: "ABSTAIN", reasonCode: "NO_GOAL" };

  const eligibleIds: CuriosityServiceId[] = [];
  const droppedTitles: string[] = [];
  let skippedTravelQuestion = false;

  for (const intent of recognized) {
    let target: CuriosityServiceId | null = null;
    if (intent === "travel") {
      if (input.travelChoice === "campus") target = "campus";
      else if (input.travelChoice === "home") target = "vacation";
      else {
        const campusReady = ready("campus");
        const homeReady = ready("vacation");
        if (campusReady && homeReady) {
          if (Number(input.questionsAsked || 0) < 1) {
            return {
              ...base,
              kind: "ASK",
              questionId: "TRAVEL_KIND",
              question: "Are you travelling around campus or heading home?",
              options: [{ id: "campus", label: "Around campus" }, { id: "home", label: "Heading home" }],
              reasonCode: "NEED_TRAVEL_KIND",
            };
          }
          skippedTravelQuestion = true;
          droppedTitles.push("Travel");
          continue;
        }
        if (campusReady || homeReady) {
          if (Number(input.questionsAsked || 0) >= 1) {
            skippedTravelQuestion = true;
            droppedTitles.push("Travel");
            continue;
          }
          target = campusReady ? "campus" : "vacation";
        } else {
          droppedTitles.push("Travel");
          continue;
        }
      }
    } else {
      target = targetByIntent[intent as CuriosityIntent] || null;
    }

    if (target) {
      if (ready(target)) {
        if (!eligibleIds.includes(target)) eligibleIds.push(target);
      } else {
        const title = catalog.find((item) => item.id === target)?.title || target;
        if (!droppedTitles.includes(title)) droppedTitles.push(title);
      }
    }
  }

  if (eligibleIds.length === 0) {
    if (skippedTravelQuestion && droppedTitles.length === 1) {
      return { ...base, kind: "ABSTAIN", reasonCode: "QUESTION_SKIPPED" };
    }
    return { ...base, kind: "ABSTAIN", reasonCode: "NO_ELIGIBLE_SERVICE" };
  }

  const orderedIds = [...eligibleIds]
    .sort((a, b) => {
      const stageA = catalog.find((item) => item.id === a)?.stageOrder ?? 99;
      const stageB = catalog.find((item) => item.id === b)?.stageOrder ?? 99;
      return stageA - stageB;
    })
    .slice(0, 3);

  const partialDropReason = droppedTitles.length > 0
    ? `Only currently available steps are shown (${droppedTitles.join(", ")} is unavailable right now).`
    : undefined;

  if (orderedIds.length === 1) {
    const capability = catalog.find((item) => item.id === orderedIds[0])!;
    return {
      ...base,
      kind: "SUGGEST",
      service: { id: capability.id, title: capability.title, href: capability.href },
      explanation: capability.explanation,
      ...(partialDropReason ? { partialDropReason } : {}),
      reasonCode: "INTENT_MATCH",
    };
  }

  const steps = orderedIds.map((id) => {
    const capability = catalog.find((item) => item.id === id)!;
    return {
      service: { id: capability.id, title: capability.title, href: capability.href },
      explanation: capability.explanation,
      uncertaintyNote: capability.uncertaintyNote || "Confirm current details on the service page before committing.",
    };
  }) as [CuriosityPathStep, ...CuriosityPathStep[]];

  return {
    ...base,
    kind: "SUGGEST_PATH",
    steps,
    ...(partialDropReason ? { partialDropReason } : {}),
    reasonCode: "PATH_MATCH",
  };
}
