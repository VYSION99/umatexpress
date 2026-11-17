import { CURIOSITY_POLICY_VERSION, type CuriosityCapability, type CuriosityIntent, type CuriosityServiceId, type TravelChoice } from "./catalog";

export type CuriosityReadiness = { serviceId: CuriosityServiceId; eligible: boolean; reasonCode: string; checkedAt: string };
export type CuriosityInput = {
  intent: CuriosityIntent | string;
  travelChoice?: TravelChoice | string;
  hiddenServiceIds?: string[];
  questionsAsked?: number;
};
export type CuriosityDecision =
  | { kind: "SUGGEST"; service: { id: CuriosityServiceId; title: string; href: string }; explanation: string; reasonCode: "INTENT_MATCH"; policyVersion: string }
  | { kind: "ASK"; questionId: "TRAVEL_KIND"; question: string; options: Array<{ id: TravelChoice; label: string }>; reasonCode: "NEED_TRAVEL_KIND"; policyVersion: string }
  | { kind: "ABSTAIN"; reasonCode: "NO_GOAL" | "SENSITIVE_INTENT" | "NO_ELIGIBLE_SERVICE" | "QUESTION_SKIPPED"; policyVersion: string };

const targetByIntent: Partial<Record<CuriosityIntent, CuriosityServiceId>> = {
  housing: "hostels", food: "food", print: "print-copy", social: "cinema",
};
const sensitiveIntents = new Set(["health", "clinic", "counselling", "counseling", "finance", "financial-help"]);

export function curiosityCandidateIds(input: CuriosityInput): CuriosityServiceId[] {
  if (input.intent === "travel") return input.travelChoice === "campus" ? ["campus"] : input.travelChoice === "home" ? ["vacation"] : ["campus", "vacation"];
  const target = targetByIntent[input.intent as CuriosityIntent];
  return target ? [target] : [];
}

/** Hard gates run before any selection; no score or caller-provided state can override them. */
export function decideCuriosity(input: CuriosityInput, catalog: CuriosityCapability[], readiness: CuriosityReadiness[]): CuriosityDecision {
  const base = { policyVersion: CURIOSITY_POLICY_VERSION };
  const intent = String(input.intent || "unknown").toLowerCase();
  if (sensitiveIntents.has(intent)) return { ...base, kind: "ABSTAIN", reasonCode: "SENSITIVE_INTENT" };
  const target = intent === "travel"
    ? input.travelChoice === "campus" ? "campus" : input.travelChoice === "home" ? "vacation" : null
    : targetByIntent[intent as CuriosityIntent] || null;
  if (!target && intent !== "travel") return { ...base, kind: "ABSTAIN", reasonCode: "NO_GOAL" };
  const hidden = new Set(input.hiddenServiceIds || []);
  const ready = (id: CuriosityServiceId) => {
    const capability = catalog.find((item) => item.id === id);
    return Boolean(capability?.launched && capability.href.startsWith("/") && !capability.href.startsWith("//") && !hidden.has(id)
      && readiness.some((item) => item.serviceId === id && item.eligible));
  };
  if (intent === "travel" && !target) {
    if (!ready("campus") && !ready("vacation")) return { ...base, kind: "ABSTAIN", reasonCode: "NO_ELIGIBLE_SERVICE" };
    if (Number(input.questionsAsked || 0) >= 1) return { ...base, kind: "ABSTAIN", reasonCode: "QUESTION_SKIPPED" };
    return { ...base, kind: "ASK", questionId: "TRAVEL_KIND", question: "Are you travelling around campus or heading home?", options: [{ id: "campus", label: "Around campus" }, { id: "home", label: "Heading home" }], reasonCode: "NEED_TRAVEL_KIND" };
  }
  if (!target || !ready(target)) return { ...base, kind: "ABSTAIN", reasonCode: "NO_ELIGIBLE_SERVICE" };
  const capability = catalog.find((item) => item.id === target)!;
  return { ...base, kind: "SUGGEST", service: { id: capability.id, title: capability.title, href: capability.href }, explanation: capability.explanation, reasonCode: "INTENT_MATCH" };
}
