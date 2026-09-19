"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";
import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import type { ConsoleBrief } from "@/lib/console-assistant";

type Turn = { role: "user" | "assistant"; text: string; tools?: string[] };
type PendingAction = { token: string; title: string; summary: string };

const SUGGESTIONS: Record<string, string[]> = {
  ADMIN: ["What needs my attention today?", "How many organizer applications are pending?", "Which trips are waiting for review?"],
  MODERATOR: ["What needs my attention today?", "Show me the open disputes"],
  ORGANIZER: ["What needs my attention today?", "How are my trips doing?"],
  DRIVER: ["What needs my attention today?", "What is my queue like?"],
};

const clockLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * The console assistant, on every console page. It reads what the signed-in
 * role may read and proposes what that role may do; a proposal is only a
 * proposal until the person presses Confirm, which is the only button that
 * changes anything.
 */
export function ConsoleAssistant({ session, service }: { session: ConsoleSessionInfo; service: string }) {
  const role = session.account.role;
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [brief, setBrief] = useState<ConsoleBrief | null>(null);
  const briefRequested = useRef(false);

  // The brief is read on the console home and whenever the panel is first
  // opened. It is a convenience, never a blocker: a failed read leaves the
  // panel exactly as it was.
  useEffect(() => {
    if (briefRequested.current || (!open && service !== "home")) return;
    briefRequested.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/console/assistant/brief", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data && Array.isArray(data.items)) setBrief(data as ConsoleBrief);
      } catch {
        // The assistant answers without a brief.
      }
    })();
    return () => { cancelled = true; };
  }, [open, service]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    const history = turns.slice(-6).map((turn) => ({ role: turn.role, content: turn.text }));
    setTurns((current) => [...current, { role: "user", text }]);
    try {
      const response = await fetch("/api/console/assistant", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, history, page: service === "home" ? "/console" : `/console/${service}` }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The assistant could not answer.");
      setTurns((current) => [...current, { role: "assistant", text: data.reply || "No answer returned.", tools: data.toolRuns }]);
      setPending(data.pendingAction || null);
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "The assistant could not answer.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending || confirming) return;
    setConfirming(true);
    setError("");
    try {
      const response = await fetch("/api/console/assistant/confirm", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: pending.token }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The action could not be completed.");
      setTurns((current) => [...current, { role: "assistant", text: `Done: ${data.title}.` }]);
      setPending(null);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "The action could not be completed.");
    } finally {
      setConfirming(false);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(message);
  };

  const actionsWaiting = brief?.items.filter((item) => item.tone === "action").length || 0;

  return <div className="console-assistant">
    {open && <section className="console-assistant-panel" aria-label="Console assistant">
      <header>
        <span><Sparkles size={16}/> Console assistant</span>
        <button type="button" aria-label="Close assistant" onClick={() => setOpen(false)}><X size={17}/></button>
      </header>
      <div className="console-assistant-log" aria-live="polite">
        {brief && !turns.length && <section className="console-assistant-brief" aria-label="Daily brief">
          <header>
            <strong>{brief.headline}</strong>
            <small>Daily brief{clockLabel(brief.generatedAt) ? ` · as of ${clockLabel(brief.generatedAt)}` : ""}</small>
          </header>
          <p className="console-assistant-brief-summary">{brief.summary}</p>
          <ul>
            {brief.items.map((item) => <li key={item.key} className={`console-assistant-brief-item tone-${item.tone}`}>
              {item.href
                ? <Link href={item.href}>
                    <span className="console-assistant-brief-value">{item.value}</span>
                    <span className="console-assistant-brief-label">{item.label}</span>
                  </Link>
                : <span className="console-assistant-brief-plain">
                    <span className="console-assistant-brief-value">{item.value}</span>
                    <span className="console-assistant-brief-label">{item.label}</span>
                  </span>}
              {item.detail && <small>{item.detail}</small>}
            </li>)}
          </ul>
          {brief.note && <p className="console-assistant-brief-note">{brief.note}</p>}
        </section>}
        {!turns.length && <p className="console-assistant-hint">Ask about this console — the assistant reads only what your role may read, and proposes actions for you to confirm.</p>}
        {turns.map((turn, index) => <article key={index} className={`console-assistant-turn console-assistant-${turn.role}`}>
          <p>{turn.text}</p>
          {Boolean(turn.tools?.length) && <small>Checked: {turn.tools?.join(", ")}</small>}
        </article>)}
        {!turns.length && <div className="console-assistant-suggestions">
          {(SUGGESTIONS[role] || SUGGESTIONS.ADMIN).map((suggestion) => <button key={suggestion} type="button" onClick={() => void ask(suggestion)}>{suggestion}</button>)}
        </div>}
      </div>
      {pending && <div className="console-assistant-confirm" role="group" aria-label="Proposed action">
        <strong>{pending.title}</strong>
        <span>{pending.summary || "Review the details before confirming."}</span>
        <div>
          <button type="button" onClick={() => void confirm()} disabled={confirming}>{confirming ? "Applying…" : "Confirm"}</button>
          <button type="button" className="console-secondary" onClick={() => setPending(null)} disabled={confirming}>Dismiss</button>
        </div>
      </div>}
      {error && <p className="console-assistant-error" role="alert">{error}</p>}
      <form onSubmit={submit}>
        <textarea
          aria-label="Ask the console assistant"
          value={message}
          placeholder="Ask about this console…"
          onChange={(event) => setMessage(event.target.value)}
        />
        <button type="submit" disabled={busy || !message.trim()}><Send size={16}/>{busy ? "Thinking…" : "Ask"}</button>
      </form>
    </section>}
    <button type="button" className="console-assistant-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <Sparkles size={18}/> Assistant
      {!open && actionsWaiting > 0 && <span className="console-assistant-badge" aria-label={`${actionsWaiting} things need attention`}>{actionsWaiting}</span>}
    </button>
  </div>;
}
