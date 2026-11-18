"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CuriosityDecision, CuriosityPathStep } from "@/lib/curiosity/policy";
import { curiosityServiceIds, type CuriosityIntent, type CuriosityServiceId, type TravelChoice } from "@/lib/curiosity/catalog";
import { services, type LauncherPreference } from "./services";
import "./curiosity.css";

const OFF_KEY = "umatexpress.curiosity.off.v1";
const DISMISS_KEY = "umatexpress.curiosity.dismissed.v1";
const VISIT_KEY = "umatexpress.curiosity.visit.v1";
const SUPPRESS_MS = 7 * 24 * 60 * 60_000;

type GoalOption = { id: string; label: string; intent?: CuriosityIntent; intents?: CuriosityIntent[] };

function availableGoalOptions(preferences: LauncherPreference[]): GoalOption[] {
  const hidden = new Set(preferences.filter((item) => item.hidden).map((item) => item.id));
  const isAvailable = (id: string) => services.some((s) => s.id === id && s.available) && !hidden.has(id);
  const options: GoalOption[] = [];
  if (isAvailable("campus") || isAvailable("vacation")) options.push({ id: "travel", intent: "travel", label: "Plan travel" });
  if (isAvailable("hostels")) options.push({ id: "housing", intent: "housing", label: "Find a place" });
  if (isAvailable("food")) options.push({ id: "food", intent: "food", label: "Find food" });
  if (isAvailable("print-copy")) options.push({ id: "print", intent: "print", label: "Print & copy" });
  if (isAvailable("cinema")) options.push({ id: "social", intent: "social", label: "Take a break" });
  if ((isAvailable("campus") || isAvailable("vacation")) && isAvailable("cinema")) {
    options.push({ id: "travel-social", intents: ["travel", "social"], label: "Travel + take a break" });
  }
  return options;
}

type Dismissal = Record<string, { count: number; until: number }>;
function savedDismissals(): Dismissal {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Dismissal : {};
  } catch { return {}; }
}
function suppressed(id: string) {
  try {
    if (sessionStorage.getItem(VISIT_KEY)?.split(",").includes(id)) return true;
    return Number(savedDismissals()[id]?.until || 0) > Date.now();
  } catch { return false; }
}
function currentSuppressedServiceIds(): CuriosityServiceId[] {
  return curiosityServiceIds.filter((id) => suppressed(id));
}

export function CuriosityPilot({ preferences }: { preferences: LauncherPreference[] }) {
  const [enabled, setEnabled] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [off, setOff] = useState(() => { try { return typeof window !== "undefined" && localStorage.getItem(OFF_KEY) === "1"; } catch { return false; } });
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<CuriosityDecision | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [activeIntents, setActiveIntents] = useState<CuriosityIntent[]>([]);
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState<"idle" | "busy" | "done" | "already" | "skipped">("idle");
  const [stepFeedback, setStepFeedback] = useState<Record<string, "idle" | "busy" | "done" | "already" | "skipped">>({});
  const [feedbackToken, setFeedbackToken] = useState("");
  const latest = useRef(0);
  const feedbackPending = useRef(false);

  useEffect(() => {
    let active = true;
    fetch("/api/curiosity/decision", { cache: "no-store" }).then((response) => response.json()).then((data: { enabled?: boolean }) => {
      if (active) setEnabled(data.enabled === true);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function chooseGoal(goal: GoalOption, travelChoice?: TravelChoice, questionsAsked = 0) {
    const sequence = ++latest.current;
    feedbackPending.current = false;
    const nextIntents = goal.intents ?? (goal.intent ? [goal.intent] : ["travel"]);
    setBusy(true);
    setSelectedGoalId(goal.id);
    setActiveIntents(nextIntents);
    setDecision(null);
    setMessage("");
    setFeedback("idle");
    setStepFeedback({});
    setFeedbackToken("");
    try {
      const hiddenServiceIds = preferences.filter((item) => item.hidden).map((item) => item.id);
      const suppressedServiceIds = currentSuppressedServiceIds();
      const payload = nextIntents.length > 1
        ? { intents: nextIntents, travelChoice, questionsAsked, hiddenServiceIds, suppressedServiceIds }
        : { intent: nextIntents[0], travelChoice, questionsAsked, hiddenServiceIds, suppressedServiceIds };
      const response = await fetch("/api/curiosity/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as { decision?: CuriosityDecision; feedbackToken?: string; error?: string };
      if (sequence !== latest.current) return;
      if (!response.ok || !data.decision) throw new Error(data.error || "A suggestion is unavailable right now.");
      if (data.decision.kind === "SUGGEST" && suppressed(data.decision.service.id)) {
        setMessage("You dismissed this suggestion. Your usual service cards are still available below.");
      } else if (data.decision.kind === "ABSTAIN") {
        setMessage(data.decision.reasonCode === "QUESTION_SKIPPED" ? "No problem. Explore the service cards whenever you like." : "There isn’t a checked suggestion for that goal right now. You can still browse the services below.");
      } else {
        setDecision(data.decision);
        setFeedbackToken(data.decision.kind === "SUGGEST" ? data.feedbackToken || "" : "");
      }
    } catch (error) {
      if (sequence === latest.current) setMessage(error instanceof Error ? error.message : "A suggestion is unavailable right now.");
    } finally {
      if (sequence === latest.current) setBusy(false);
    }
  }

  function dismiss(id: string) {
    if (decision?.kind === "SUGGEST_PATH") {
      const remaining = decision.steps.filter((step) => step.service.id !== id);
      if (remaining.length >= 2) {
        setDecision({ ...decision, steps: remaining as [CuriosityPathStep, ...CuriosityPathStep[]] });
        setMessage("Step dismissed for this visit.");
      } else if (remaining.length === 1) {
        const sole = remaining[0];
        setDecision({
          kind: "SUGGEST",
          service: sole.service,
          explanation: sole.explanation,
          reasonCode: "INTENT_MATCH",
          policyVersion: decision.policyVersion,
        });
        setFeedbackToken(sole.feedbackToken || "");
        setMessage("Step dismissed for this visit.");
      } else {
        setDecision(null);
        setFeedbackToken("");
        setMessage("Dismissed for this visit. Your service cards stay available below.");
      }
    } else {
      setDecision(null);
      setFeedbackToken("");
      setMessage("Dismissed for this visit. Your service cards stay available below.");
    }
    try {
      const visit = new Set((sessionStorage.getItem(VISIT_KEY) || "").split(",").filter(Boolean));
      visit.add(id); sessionStorage.setItem(VISIT_KEY, [...visit].join(","));
      const entries = savedDismissals();
      const count = Math.max(0, Number(entries[id]?.count || 0)) + 1;
      entries[id] = { count, until: count >= 2 ? Date.now() + SUPPRESS_MS : 0 };
      localStorage.setItem(DISMISS_KEY, JSON.stringify(entries));
    } catch { /* Visit-only dismissal still clears the visible card. */ }
  }

  function turnOff() {
    latest.current++; feedbackPending.current = false; setOff(true); setOptedIn(false); setDecision(null); setFeedbackToken(""); setBusy(false);
    try { localStorage.setItem(OFF_KEY, "1"); } catch { /* Off for this visit. */ }
  }
  function reset() {
    latest.current++; feedbackPending.current = false;
    setOff(false); setDecision(null); setSelectedGoalId(null); setActiveIntents([]); setMessage(""); setFeedback("idle"); setStepFeedback({}); setFeedbackToken(""); setBusy(false);
    try { localStorage.removeItem(OFF_KEY); localStorage.removeItem(DISMISS_KEY); sessionStorage.removeItem(VISIT_KEY); } catch { /* Local reset still applies to this visit. */ }
  }

  async function submitFeedback(outcome: "HELPFUL" | "NOT_HELPFUL", stepServiceId?: CuriosityServiceId, stepToken?: string) {
    if (stepServiceId && stepToken) {
      const currentState = stepFeedback[stepServiceId] || "idle";
      if (currentState !== "idle" || !decision) return;
      const sequence = latest.current;
      setStepFeedback((prev) => ({ ...prev, [stepServiceId]: "busy" }));
      try {
        const response = await fetch("/api/curiosity/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serviceId: stepServiceId, policyVersion: decision.policyVersion, outcome, feedbackToken: stepToken }),
        });
        if (!response.ok) throw new Error("Feedback could not be saved.");
        const result = await response.json() as { recorded?: boolean };
        if (sequence === latest.current) {
          setStepFeedback((prev) => ({ ...prev, [stepServiceId]: result.recorded === false ? "already" : "done" }));
        }
      } catch {
        if (sequence === latest.current) {
          setStepFeedback((prev) => ({ ...prev, [stepServiceId]: "idle" }));
          setMessage("Feedback could not be saved. You can try again.");
        }
      }
      return;
    }

    if (feedback !== "idle" || feedbackPending.current || decision?.kind !== "SUGGEST" || !feedbackToken) return;
    feedbackPending.current = true;
    const sequence = latest.current;
    setFeedback("busy");
    try {
      const response = await fetch("/api/curiosity/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: decision.service.id, policyVersion: decision.policyVersion, outcome, feedbackToken }) });
      if (!response.ok) throw new Error("Feedback could not be saved. You can try again.");
      const result = await response.json() as { recorded?: boolean };
      if (sequence === latest.current) setFeedback(result.recorded === false ? "already" : "done");
    } catch { if (sequence === latest.current) { setFeedback("idle"); setMessage("Feedback could not be saved. You can try again."); } }
    finally { if (sequence === latest.current) feedbackPending.current = false; }
  }

  if (!enabled) return null;
  if (off) return <section className="curiosity-off" aria-label="Guided discovery"><span>Guided discovery is off.</span><button type="button" onClick={reset}>Turn it on</button></section>;
  if (!optedIn) return <section className="curiosity-panel curiosity-invite" aria-labelledby="curiosity-title">
    <div className="curiosity-heading"><div><span>OPTIONAL DISCOVERY PILOT</span><h2 id="curiosity-title">Would a little help finding a service be useful?</h2><p>Choose to try it, then pick a goal. We may suggest one checked service, a short multi-step path, or ask one short question. You can leave at any time.</p></div><button type="button" onClick={turnOff}>Turn off</button></div>
    <button className="curiosity-join" type="button" onClick={() => setOptedIn(true)}>Try guided discovery</button>
    <p className="curiosity-footnote">No free-text goals or account details are collected. An anonymous 7-day cookie controls pilot access. If you rate a suggestion, a short-lived receipt prevents duplicates; we keep daily totals by service.</p>
  </section>;

  const choices = availableGoalOptions(preferences);
  const hiddenSet = new Set(preferences.filter((item) => item.hidden).map((item) => item.id));
  const current: CuriosityDecision | null = (() => {
    if (!decision) return null;
    if (decision.kind === "SUGGEST") return hiddenSet.has(decision.service.id) ? null : decision;
    if (decision.kind === "SUGGEST_PATH") {
      const visibleSteps = decision.steps.filter((step) => !hiddenSet.has(step.service.id));
      if (visibleSteps.length === 0) return null;
      if (visibleSteps.length === 1) {
        return {
          kind: "SUGGEST",
          service: visibleSteps[0].service,
          explanation: visibleSteps[0].explanation,
          reasonCode: "INTENT_MATCH",
          policyVersion: decision.policyVersion,
        };
      }
      return { ...decision, steps: visibleSteps as [CuriosityPathStep, ...CuriosityPathStep[]] };
    }
    return decision;
  })();
  const activeGoal: GoalOption = choices.find((c) => c.id === selectedGoalId) || { id: selectedGoalId || "travel", intents: activeIntents.length ? activeIntents : ["travel"], label: "" };

  return <section className="curiosity-panel" aria-labelledby="curiosity-title">
    <div className="curiosity-heading"><div><span>OPTIONAL DISCOVERY</span><h2 id="curiosity-title">What would help today?</h2><p>Choose a goal. We’ll suggest one checked service, a short path, or ask one short question.</p></div><button type="button" onClick={() => { latest.current++; feedbackPending.current = false; setOptedIn(false); setDecision(null); setSelectedGoalId(null); setActiveIntents([]); setMessage(""); setFeedbackToken(""); setFeedback("idle"); setStepFeedback({}); setBusy(false); }}>Leave pilot</button></div>
    <div className="curiosity-choices" aria-label="Choose a goal">{choices.map((choice) => <button type="button" key={choice.id} onClick={() => void chooseGoal(choice)} disabled={busy} aria-pressed={selectedGoalId === choice.id}>{choice.label}</button>)}</div>
    {busy && <p className="curiosity-message" role="status">Checking what’s available…</p>}
    {current?.kind === "ASK" && <div className="curiosity-result" role="status" aria-live="polite"><h3>{current.question}</h3><div className="curiosity-choices">{current.options.map((option) => <button type="button" key={option.id} onClick={() => void chooseGoal(activeGoal, option.id, 1)} disabled={busy}>{option.label}</button>)}<button type="button" onClick={() => void chooseGoal(activeGoal, undefined, 1)} disabled={busy}>Skip</button></div></div>}
    {current?.kind === "SUGGEST" && <div className="curiosity-result" role="status"><span className="curiosity-reason">Why this suggestion</span><h3>{current.service.title}</h3><p>{current.explanation}</p>{current.partialDropReason && <p className="curiosity-partial-note">{current.partialDropReason}</p>}<div className="curiosity-actions"><Link href={current.service.href}>Explore {current.service.title}</Link><button type="button" onClick={() => dismiss(current.service.id)}>Dismiss</button></div><div className="curiosity-feedback" aria-label="Optional suggestion feedback"><span>Was this suggestion useful?</span>{feedback === "done" ? <span role="status">Thanks for your feedback.</span> : feedback === "already" ? <span role="status">You already rated this service today.</span> : feedback === "skipped" ? <span role="status">Skipped. No feedback saved.</span> : <><button type="button" disabled={feedback === "busy" || !feedbackToken} onClick={() => void submitFeedback("HELPFUL")}>Helpful</button><button type="button" disabled={feedback === "busy" || !feedbackToken} onClick={() => void submitFeedback("NOT_HELPFUL")}>Not useful</button><button type="button" disabled={feedback === "busy"} onClick={() => setFeedback("skipped")}>Skip</button></>}</div></div>}
    {current?.kind === "SUGGEST_PATH" && <div className="curiosity-result" role="status">
      <span className="curiosity-reason">Suggested {current.steps.length}-step path</span>
      {current.partialDropReason && <p className="curiosity-partial-note">{current.partialDropReason}</p>}
      <ol className="curiosity-path-steps">
        {current.steps.map((step, index) => {
          const stState = stepFeedback[step.service.id] || "idle";
          return <li key={step.service.id} className="curiosity-path-step">
            <span className="curiosity-step-badge">Step {index + 1} of {current.steps.length}</span>
            <h3>{step.service.title}</h3>
            <p>{step.explanation}</p>
            <p className="curiosity-uncertainty">{step.uncertaintyNote}</p>
            <div className="curiosity-actions">
              <Link href={step.service.href}>Explore {step.service.title}</Link>
              <button type="button" onClick={() => dismiss(step.service.id)}>Dismiss</button>
            </div>
            <div className="curiosity-feedback" aria-label={`Optional feedback for ${step.service.title}`}>
              <span>Was this step useful?</span>
              {stState === "done" ? <span role="status">Thanks for your feedback.</span> : stState === "already" ? <span role="status">You already rated this service today.</span> : stState === "skipped" ? <span role="status">Skipped.</span> : <>
                <button type="button" disabled={stState === "busy" || !step.feedbackToken} onClick={() => void submitFeedback("HELPFUL", step.service.id, step.feedbackToken)}>Helpful</button>
                <button type="button" disabled={stState === "busy" || !step.feedbackToken} onClick={() => void submitFeedback("NOT_HELPFUL", step.service.id, step.feedbackToken)}>Not useful</button>
                <button type="button" disabled={stState === "busy"} onClick={() => setStepFeedback((prev) => ({ ...prev, [step.service.id]: "skipped" }))}>Skip</button>
              </>}
            </div>
          </li>;
        })}
      </ol>
    </div>}
    {message && <p className="curiosity-message" role="status">{message}</p>}
    <p className="curiosity-footnote">Your goal stays in this visit. Suggestions never book or pay for you. <button type="button" onClick={reset}>Reset suggestions</button></p>
  </section>;
}
