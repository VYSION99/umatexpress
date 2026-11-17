"use client";

import { useCallback, useEffect, useState } from "react";
import "./curiosity-shadow.css";

type ShadowReport = {
  policyVersion: string;
  checkedAt: string;
  summary: { checked: number; passed: number; failed: number; eligibleServices: number; readinessHolds: number };
  readiness: Array<{ id: string; title: string; launched: boolean; eligible: boolean; reasonCode: string }>;
  scenarios: Array<{ id: string; label: string; kind: string; reasonCode: string; serviceId: string | null; explanation: string | null; violations: string[] }>;
};

export function CuriosityShadowPanel() {
  const [report, setReport] = useState<ShadowReport | null>(null);
  const [pilotEnabled, setPilotEnabled] = useState(false);
  const [feedback, setFeedback] = useState<{ available: boolean; rows: Array<{ policyVersion: string; serviceId: string; outcome: string; count: number }> }>({ available: false, rows: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setError(""); setReport(null);
    try {
      const response = await fetch("/api/console/curiosity/shadow", { cache: "no-store" });
      const data = await response.json() as { report?: ShadowReport; pilotEnabled?: boolean; feedback?: { available: boolean; rows: Array<{ policyVersion: string; serviceId: string; outcome: string; count: number }> }; error?: string };
      if (!response.ok || !data.report) throw new Error(data.error || "Curiosity diagnostics could not be loaded.");
      setReport(data.report); setPilotEnabled(data.pilotEnabled === true); setFeedback(data.feedback || { available: false, rows: [] });
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Curiosity diagnostics could not be loaded."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  return <div className="curiosity-console">
    <section className="console-card curiosity-console-intro"><div><h2>Synthetic shadow check</h2><p>This runs fixed example goals against live service readiness. It does not read student sessions, store goal text, or show suggestions to students.</p></div><button type="button" onClick={() => void load()} disabled={busy}>{busy ? "Checking…" : "Refresh checks"}</button></section>
    {error && <p className="console-alert" role="alert">{error}</p>}
    {report && <>
      <section className="console-card curiosity-console-summary" aria-label="Curiosity policy check summary"><div><span>Pilot</span><strong>{pilotEnabled ? "Enabled" : "Off"}</strong></div><div><span>Policy</span><strong>{report.policyVersion}</strong></div><div><span>Scenarios</span><strong>{report.summary.passed}/{report.summary.checked} passed</strong></div><div><span>Eligible services</span><strong>{report.summary.eligibleServices}</strong></div><div><span>Policy failures</span><strong>{report.summary.failed}</strong></div><div><span>Readiness holds</span><strong>{report.summary.readinessHolds}</strong></div></section>
      <section className="console-card"><h2>Service readiness</h2><p>A service can be live in navigation and still be excluded from suggestions if its required evidence is missing.</p><div className="curiosity-console-list">{report.readiness.map((item) => <div key={item.id}><strong>{item.title}</strong><span>{item.eligible ? "Eligible" : "Excluded"}</span><small>{item.reasonCode}</small></div>)}</div></section>
      <section className="console-card"><h2>Voluntary pilot feedback</h2><p>Daily service totals from the last 90 days, separated by policy version. No student IDs or goals are stored. These counts do not measure task completion or comfort by themselves.</p>{!feedback.available ? <p>Feedback totals are unavailable.</p> : feedback.rows.length ? <div className="curiosity-console-list">{feedback.rows.map((row) => <div key={`${row.policyVersion}-${row.serviceId}-${row.outcome}`}><strong>{report.readiness.find((item) => item.id === row.serviceId)?.title || row.serviceId}</strong><span>{row.outcome === "HELPFUL" ? "Helpful" : "Not useful"}: {row.count}</span><small>{row.policyVersion}</small></div>)}</div> : <p>No feedback yet.</p>}</section>
      <section className="console-card"><h2>Policy scenarios</h2><p>Checked {new Date(report.checkedAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}. A failed rule must be resolved before a pilot.</p><div className="curiosity-console-list">{report.scenarios.map((item) => <div key={item.id}><strong>{item.label}</strong><span>{item.kind}{item.serviceId ? ` · ${item.serviceId}` : ""}</span><small>{item.violations.length ? item.violations.join(", ") : item.reasonCode}</small>{item.explanation && <p>{item.explanation}</p>}</div>)}</div></section>
    </>}
  </div>;
}
