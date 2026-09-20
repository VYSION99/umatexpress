"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCheck, Loader2, Radar, ShieldAlert, X } from "lucide-react";

type Signal = {
  id: string; signalKey: string; severity: string; entityType: string; entityId: string;
  landlordId: string; propertyId: string; title: string; detail: string;
  evidence: Record<string, unknown>; status: string; reviewedBy: string; reviewedAt: string;
  reviewNote: string; createdAt: string;
};
type Summary = { open: number; high: number; medium: number; low: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const FILTERS = ["OPEN", "REVIEWED", "DISMISSED"] as const;
const severityBadge = (severity: string) => severity === "HIGH" ? "rejected" : severity === "MEDIUM" ? "pending" : "draft";

/**
 * The trust desk. Every card is something a rule noticed — a price far from the
 * year, a live listing without verification, a thread drifting off-platform —
 * with the evidence attached, so the decision stays with a person.
 */
export function RiskSignalsPanel() {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("OPEN");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/api/console/hostel/signals?status=${filter}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { signals?: Signal[]; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error || "The signals could not be loaded.");
      setSignals(data.signals || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The signals could not be loaded.");
    }
  }, [filter]);

  const run = useCallback(async (task: () => Promise<void>) => {
    setError("");
    try {
      await task();
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : "That did not work.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void run(load));
  }, [load, run]);

  async function scan() {
    await run(async () => {
      setBusy("scan");
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/signals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "SCAN" }),
        });
        const data = await response.json() as { result?: { raised: number; open: number }; error?: string };
        if (!response.ok) throw new Error(data.error || "The scan did not finish.");
        setNotice(data.result ? `Scan finished: ${data.result.raised} signals refreshed, ${data.result.open} open now.` : "Scan finished.");
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  async function resolve(signal: Signal, action: "REVIEW" | "DISMISS") {
    await run(async () => {
      setBusy(signal.id);
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/signals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, signalId: signal.id, note: notes[signal.id] || "" }),
        });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error || "That decision was not saved.");
        setNotice(action === "REVIEW" ? "Recorded as reviewed." : "Signal dismissed.");
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  if (!signals) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Reading the signals…</p>;

  return <section className="console-panel">
    <h2><Radar size={18} aria-hidden />Supply signals
      {summary && summary.open > 0 && <span className="console-badge console-badge-rejected">{summary.open} open</span>}
      <button type="button" className="console-panel-close" onClick={() => void run(scan)} disabled={busy === "scan"}>
        {busy === "scan" ? <Loader2 size={14} className="console-spin" aria-hidden /> : <Radar size={14} aria-hidden />} Rescan now
      </button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    {summary && <p className="console-note">
      {summary.open === 0 ? "Nothing is waiting under this filter." : `${summary.high} high · ${summary.medium} medium · ${summary.low} low.`}
      {" "}Signals never block a listing or a booking on their own.
    </p>}
    <div className="console-toolbar">
      {FILTERS.map((option) => <button key={option} type="button" className={filter === option ? "is-active" : ""} onClick={() => setFilter(option)}>
        {option === "OPEN" ? "Open" : option === "REVIEWED" ? "Reviewed" : "Dismissed"}
      </button>)}
    </div>
    {signals.length === 0
      ? <p className="console-empty">Nothing here.</p>
      : <ul className="console-reviews">
        {signals.map((signal) => <li key={signal.id}>
          <header>
            <span className={`console-badge console-badge-${severityBadge(signal.severity)}`}><ShieldAlert size={11} aria-hidden />{signal.severity}</span>
            <strong>{signal.title}</strong>
            <small>{signal.entityType.toLowerCase()} · {when(signal.createdAt)}</small>
          </header>
          <p>{signal.detail}</p>
          <p className="console-note">{Object.entries(signal.evidence || {}).slice(0, 4).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`).join(" · ")}</p>
          {signal.status === "OPEN"
            ? <div className="console-row-actions">
              <input type="text" value={notes[signal.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [signal.id]: event.target.value }))} placeholder="What did you find?" maxLength={500} />
              <button type="button" className="console-secondary" disabled={busy === signal.id || !(notes[signal.id] || "").trim()} onClick={() => void resolve(signal, "REVIEW")}>
                {busy === signal.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <CheckCheck size={14} aria-hidden />} Mark reviewed
              </button>
              <button type="button" className="console-secondary" disabled={busy === signal.id || !(notes[signal.id] || "").trim()} onClick={() => void resolve(signal, "DISMISS")}>
                <X size={14} aria-hidden /> Dismiss
              </button>
            </div>
            : <p className="console-note">{signal.status === "REVIEWED" ? "Reviewed" : "Dismissed"} by {signal.reviewedBy || "staff"} · {signal.reviewNote}</p>}
        </li>)}
      </ul>}
  </section>;
}
