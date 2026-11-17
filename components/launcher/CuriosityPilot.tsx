"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CuriosityDecision } from "@/lib/curiosity/policy";
import type { CuriosityIntent, TravelChoice } from "@/lib/curiosity/catalog";
import type { LauncherPreference } from "./services";
import "./curiosity.css";

const OFF_KEY = "umatexpress.curiosity.off.v1";
const DISMISS_KEY = "umatexpress.curiosity.dismissed.v1";
const VISIT_KEY = "umatexpress.curiosity.visit.v1";
const SUPPRESS_MS = 7 * 24 * 60 * 60_000;
const choices: Array<{ intent: CuriosityIntent; label: string }> = [
  { intent: "travel", label: "Plan travel" },
  { intent: "housing", label: "Find a place" },
  { intent: "social", label: "Take a break" },
];

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

export function CuriosityPilot({ preferences }: { preferences: LauncherPreference[] }) {
  const [enabled, setEnabled] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [off, setOff] = useState(() => { try { return typeof window !== "undefined" && localStorage.getItem(OFF_KEY) === "1"; } catch { return false; } });
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<CuriosityDecision | null>(null);
  const [intent, setIntent] = useState<CuriosityIntent | null>(null);
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState<"idle" | "busy" | "done" | "already" | "skipped">("idle");
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

  async function choose(nextIntent: CuriosityIntent, travelChoice?: TravelChoice, questionsAsked = 0) {
    const sequence = ++latest.current;
    feedbackPending.current = false;
    setBusy(true); setIntent(nextIntent); setDecision(null); setMessage(""); setFeedback("idle"); setFeedbackToken("");
    try {
      const hiddenServiceIds = preferences.filter((item) => item.hidden).map((item) => item.id);
      const response = await fetch("/api/curiosity/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: nextIntent, travelChoice, questionsAsked, hiddenServiceIds }) });
      const data = await response.json() as { decision?: CuriosityDecision; feedbackToken?: string; error?: string };
      if (sequence !== latest.current) return;
      if (!response.ok || !data.decision) throw new Error(data.error || "A suggestion is unavailable right now.");
      if (data.decision.kind === "SUGGEST" && suppressed(data.decision.service.id)) {
        setMessage("You dismissed this suggestion. Your usual service cards are still available below.");
      } else if (data.decision.kind === "ABSTAIN") {
        setMessage(data.decision.reasonCode === "QUESTION_SKIPPED" ? "No problem. Explore the service cards whenever you like." : "There isn’t a checked suggestion for that goal right now. You can still browse the services below.");
      } else { setDecision(data.decision); setFeedbackToken(data.decision.kind === "SUGGEST" ? data.feedbackToken || "" : ""); }
    } catch (error) { if (sequence === latest.current) setMessage(error instanceof Error ? error.message : "A suggestion is unavailable right now."); }
    finally { if (sequence === latest.current) setBusy(false); }
  }

  function dismiss(id: string) {
    setDecision(null); setFeedbackToken(""); setMessage("Dismissed for this visit. Your service cards stay available below.");
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
    setOff(false); setDecision(null); setIntent(null); setMessage(""); setFeedback("idle"); setFeedbackToken(""); setBusy(false);
    try { localStorage.removeItem(OFF_KEY); localStorage.removeItem(DISMISS_KEY); sessionStorage.removeItem(VISIT_KEY); } catch { /* Local reset still applies to this visit. */ }
  }

  async function submitFeedback(outcome: "HELPFUL" | "NOT_HELPFUL") {
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
    <div className="curiosity-heading"><div><span>OPTIONAL DISCOVERY PILOT</span><h2 id="curiosity-title">Would a little help finding a service be useful?</h2><p>Choose to try it, then pick a goal. We may suggest one checked service or ask one short question. You can leave at any time.</p></div><button type="button" onClick={turnOff}>Turn off</button></div>
    <button className="curiosity-join" type="button" onClick={() => setOptedIn(true)}>Try guided discovery</button>
    <p className="curiosity-footnote">No free-text goals or account details are collected. An anonymous 7-day cookie controls pilot access. If you rate a suggestion, a short-lived receipt prevents duplicates; we keep daily totals by service.</p>
  </section>;
  const current = decision?.kind === "SUGGEST" && preferences.some((item) => item.id === decision.service.id && item.hidden) ? null : decision;
  return <section className="curiosity-panel" aria-labelledby="curiosity-title">
    <div className="curiosity-heading"><div><span>OPTIONAL DISCOVERY</span><h2 id="curiosity-title">What would help today?</h2><p>Choose a goal. We’ll suggest one checked service or ask one short question.</p></div><button type="button" onClick={() => { latest.current++; feedbackPending.current = false; setOptedIn(false); setDecision(null); setIntent(null); setMessage(""); setFeedbackToken(""); setFeedback("idle"); setBusy(false); }}>Leave pilot</button></div>
    <div className="curiosity-choices" aria-label="Choose a goal">{choices.map((choice) => <button type="button" key={choice.intent} onClick={() => void choose(choice.intent)} disabled={busy} aria-pressed={intent === choice.intent}>{choice.label}</button>)}</div>
    {busy && <p className="curiosity-message" role="status">Checking what’s available…</p>}
    {current?.kind === "ASK" && <div className="curiosity-result" role="status" aria-live="polite"><h3>{current.question}</h3><div className="curiosity-choices">{current.options.map((option) => <button type="button" key={option.id} onClick={() => void choose(intent || "travel", option.id, 1)} disabled={busy}>{option.label}</button>)}<button type="button" onClick={() => { setDecision(null); setMessage("No problem. Explore the service cards whenever you like."); }}>Skip</button></div></div>}
    {current?.kind === "SUGGEST" && <div className="curiosity-result" role="status"><span className="curiosity-reason">Why this suggestion</span><h3>{current.service.title}</h3><p>{current.explanation}</p><div className="curiosity-actions"><Link href={current.service.href}>Explore {current.service.title}</Link><button type="button" onClick={() => dismiss(current.service.id)}>Dismiss</button></div><div className="curiosity-feedback" aria-label="Optional suggestion feedback"><span>Was this suggestion useful?</span>{feedback === "done" ? <span role="status">Thanks for your feedback.</span> : feedback === "already" ? <span role="status">You already rated this service today.</span> : feedback === "skipped" ? <span role="status">Skipped. No feedback saved.</span> : <><button type="button" disabled={feedback === "busy" || !feedbackToken} onClick={() => void submitFeedback("HELPFUL")}>Helpful</button><button type="button" disabled={feedback === "busy" || !feedbackToken} onClick={() => void submitFeedback("NOT_HELPFUL")}>Not useful</button><button type="button" disabled={feedback === "busy"} onClick={() => setFeedback("skipped")}>Skip</button></>}</div></div>}
    {message && <p className="curiosity-message" role="status">{message}</p>}
    <p className="curiosity-footnote">Your goal stays in this visit. Suggestions never book or pay for you. <button type="button" onClick={reset}>Reset suggestions</button></p>
  </section>;
}
