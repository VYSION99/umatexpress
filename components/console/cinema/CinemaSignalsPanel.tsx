"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCheck, Flag, Loader2, MessageSquareX, RefreshCw, Square, X } from "lucide-react";

type Signal = {
  id: string;
  signalKey: string;
  severity: string;
  entityType: "ROOM" | "MESSAGE";
  entityId: string;
  sessionId: string;
  reporterName: string;
  reportCount: number;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: string;
  reviewedBy: string;
  reviewedAt: string;
  reviewNote: string;
  createdAt: string;
};
type Summary = { open: number; high: number; medium: number; low: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const FILTERS = ["OPEN", "REVIEWED", "DISMISSED"] as const;
const severityBadge = (severity: string) => severity === "HIGH" ? "rejected" : severity === "MEDIUM" ? "pending" : "draft";
const text = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : String(value));

/**
 * The watch-report desk. Every card is a student's report, not a rule's
 * suspicion: the room, the message if there is one, what the reporter said and
 * how many people said it. A moderator records what they found; the two room
 * actions beside it are the takedowns the platform already understands.
 */
export function CinemaSignalsPanel() {
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
      const response = await fetch(`/api/console/cinema/signals?status=${filter}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { signals?: Signal[]; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error || "The reports could not be loaded.");
      setSignals(data.signals || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The reports could not be loaded.");
    }
  }, [filter]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  async function resolve(signal: Signal, action: "REVIEW" | "DISMISS") {
    setBusy(signal.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/console/cinema/signals", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, signalId: signal.id, note: notes[signal.id] || "" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That decision was not saved.");
      setNotice(action === "REVIEW" ? "Recorded as reviewed." : "Report dismissed.");
      await load();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "That decision was not saved.");
    } finally {
      setBusy("");
    }
  }

  async function act(signal: Signal, action: "REMOVE_MESSAGE" | "END_ROOM") {
    setBusy(signal.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/console/cinema/sessions/${signal.sessionId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "REMOVE_MESSAGE" ? { action, messageId: signal.entityId } : { action }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That action was refused.");
      setNotice(action === "REMOVE_MESSAGE" ? "The message was removed from the room and the replay." : "The room was ended and its sockets closed.");
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : "That action was refused.");
    } finally {
      setBusy("");
    }
  }

  if (!signals) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Reading the reports…</p>;

  return <section className="console-panel">
    <h2><Flag size={18} aria-hidden />Watch reports
      {summary && summary.open > 0 && <span className="console-badge console-badge-rejected">{summary.open} open</span>}
      <button type="button" className="console-panel-close" onClick={() => void load()}><RefreshCw size={14} aria-hidden />Refresh</button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    {summary && <p className="console-note">
      {summary.open === 0 ? "Nothing is waiting under this filter." : `${summary.high} high · ${summary.medium} medium · ${summary.low} low.`}
      {" "}A report never ends a room or removes a message on its own; a person decides.
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
            <span className={`console-badge console-badge-${severityBadge(signal.severity)}`}><Flag size={11} aria-hidden />{signal.severity}</span>
            <strong>{signal.title}</strong>
            <small>{signal.entityType === "MESSAGE" ? "message" : "room"} · {signal.reportCount} report{signal.reportCount === 1 ? "" : "s"} · {when(signal.createdAt)}</small>
          </header>
          <p>{signal.detail}</p>
          <p className="console-note">
            {text(signal.evidence.roomTitle)}
            {signal.entityType === "MESSAGE" ? ` · “${text(signal.evidence.messageExcerpt)}” — ${text(signal.evidence.messageSenderName)}` : ""}
          </p>
          <small>Last reported by {signal.reporterName || "a student"}.</small>
          {signal.status === "OPEN"
            ? <div className="console-row-actions">
              <input type="text" value={notes[signal.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [signal.id]: event.target.value }))} placeholder="What did you find?" maxLength={500} />
              <button type="button" disabled={busy === signal.id || !(notes[signal.id] || "").trim()} onClick={() => void resolve(signal, "REVIEW")}>
                {busy === signal.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <CheckCheck size={14} aria-hidden />} Mark reviewed
              </button>
              <button type="button" disabled={busy === signal.id || !(notes[signal.id] || "").trim()} onClick={() => void resolve(signal, "DISMISS")}>
                <X size={14} aria-hidden /> Dismiss
              </button>
            </div>
            : <p className="console-note">{signal.reviewNote ? `${signal.reviewedBy}: ${signal.reviewNote}` : `Closed by ${signal.reviewedBy}.`}</p>}
          {signal.status === "OPEN" && <div className="console-row-actions">
            {signal.entityType === "MESSAGE" && <button type="button" disabled={busy === signal.id} onClick={() => void act(signal, "REMOVE_MESSAGE")}>
              <MessageSquareX size={14} aria-hidden /> Remove message
            </button>}
            <button type="button" disabled={busy === signal.id} onClick={() => void act(signal, "END_ROOM")}>
              <Square size={14} aria-hidden /> End room
            </button>
          </div>}
        </li>)}
      </ul>}
  </section>;
}
