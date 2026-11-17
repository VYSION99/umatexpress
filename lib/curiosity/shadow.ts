import { CURIOSITY_POLICY_VERSION, curiosityCatalog, type CuriosityCapability } from "./catalog";
import { decideCuriosity, type CuriosityDecision, type CuriosityInput, type CuriosityReadiness } from "./policy";
import { curiosityReadiness } from "./readiness";

type ShadowCase = { id: string; label: string; input: CuriosityInput };
const cases: readonly ShadowCase[] = [
  { id: "travel-choice", label: "Travel needs a direction", input: { intent: "travel" } },
  { id: "campus-travel", label: "Around campus", input: { intent: "travel", travelChoice: "campus", questionsAsked: 1 } },
  { id: "home-travel", label: "Travel home", input: { intent: "travel", travelChoice: "home", questionsAsked: 1 } },
  { id: "housing", label: "Find a place", input: { intent: "housing" } },
  { id: "social", label: "Take a break", input: { intent: "social" } },
  { id: "printing", label: "Printing", input: { intent: "print" } },
  { id: "food", label: "Food", input: { intent: "food" } },
  { id: "hidden-campus", label: "Hidden service stays hidden", input: { intent: "travel", travelChoice: "campus", hiddenServiceIds: ["campus"], questionsAsked: 1 } },
  { id: "question-skipped", label: "One-question budget", input: { intent: "travel", questionsAsked: 1 } },
  { id: "sensitive-health", label: "Sensitive goal abstains", input: { intent: "health" } },
  { id: "unknown", label: "Unknown goal abstains", input: { intent: "unknown" } },
];

function violationsFor(input: CuriosityInput, decision: CuriosityDecision, catalog: CuriosityCapability[], readiness: CuriosityReadiness[]) {
  const violations: string[] = [];
  const eligible = (id: string) => {
    const capability = catalog.find((item) => item.id === id);
    return Boolean(capability?.launched && capability.href.startsWith("/") && !capability.href.startsWith("//")
      && !input.hiddenServiceIds?.includes(id) && readiness.some((item) => item.serviceId === id && item.eligible));
  };
  const target = input.intent === "travel" ? input.travelChoice === "campus" ? "campus" : input.travelChoice === "home" ? "vacation" : null
    : { housing: "hostels", social: "cinema", print: "print-copy", food: "food" }[input.intent] || null;
  const expectedKind = input.intent === "travel" && !target && Number(input.questionsAsked || 0) < 1 && (eligible("campus") || eligible("vacation"))
    ? "ASK" : target && eligible(target) ? "SUGGEST" : "ABSTAIN";
  if (decision.kind !== expectedKind) violations.push("UNEXPECTED_DECISION");
  if (decision.policyVersion !== CURIOSITY_POLICY_VERSION) violations.push("POLICY_VERSION_MISMATCH");
  if (decision.kind === "SUGGEST") {
    const id = decision.service.id;
    const capability = catalog.find((item) => item.id === id);
    if (!capability?.launched || capability.href !== decision.service.href || !capability.href.startsWith("/") || capability.href.startsWith("//")) violations.push("UNLAUNCHED_OR_EXTERNAL_SUGGESTION");
    if (!readiness.some((item) => item.serviceId === id && item.eligible)) violations.push("READINESS_BYPASS");
    if (input.hiddenServiceIds?.includes(id)) violations.push("HIDDEN_SERVICE_SUGGESTED");
    if (capability?.explanation !== decision.explanation) violations.push("UNAPPROVED_EXPLANATION");
  }
  if (decision.kind === "ASK" && Number(input.questionsAsked || 0) >= 1) violations.push("QUESTION_BUDGET_EXCEEDED");
  if ((input.intent === "health" || input.intent === "unknown") && decision.kind !== "ABSTAIN") violations.push("SENSITIVE_OR_UNKNOWN_SUGGESTED");
  return [...new Set(violations)];
}

/** Operator inspection only: fixed scenarios, no student sessions or goal text. */
export async function runCuriosityShadow(input: { catalog?: CuriosityCapability[]; readiness?: CuriosityReadiness[] } = {}) {
  const catalog = input.catalog ?? curiosityCatalog();
  const readiness = input.readiness ?? await curiosityReadiness(catalog);
  const readinessRows = catalog.map((capability) => {
    const checked = readiness.find((item) => item.serviceId === capability.id);
    return { id: capability.id, title: capability.title, launched: capability.launched, eligible: checked?.eligible === true, reasonCode: checked?.reasonCode || "NOT_CHECKED", checkedAt: checked?.checkedAt || "" };
  });
  const scenarios = cases.map((scenario) => {
    const decision = decideCuriosity(scenario.input, catalog, readiness);
    const violations = violationsFor(scenario.input, decision, catalog, readiness);
    return {
      id: scenario.id, label: scenario.label, kind: decision.kind, reasonCode: decision.reasonCode,
      serviceId: decision.kind === "SUGGEST" ? decision.service.id : null,
      explanation: decision.kind === "SUGGEST" ? decision.explanation : null,
      violations,
    };
  });
  return {
    policyVersion: CURIOSITY_POLICY_VERSION,
    checkedAt: new Date().toISOString(),
    readiness: readinessRows,
    scenarios,
    summary: {
      checked: scenarios.length,
      passed: scenarios.filter((row) => !row.violations.length).length,
      failed: scenarios.filter((row) => row.violations.length).length,
      eligibleServices: readinessRows.filter((row) => row.eligible).length,
      readinessHolds: readinessRows.filter((row) => row.launched && ["DATA_UNAVAILABLE", "READINESS_CHECK_FAILED", "NOT_CHECKED"].includes(row.reasonCode)).length,
    },
  };
}
