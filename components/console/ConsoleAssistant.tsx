"use client";

import { FormEvent, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";
import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";

type Turn = { role: "user" | "assistant"; text: string; tools?: string[] };
type PendingAction = { token: string; title: string; summary: string };

const SUGGESTIONS: Record<string, string[]> = {
  ADMIN: ["What needs my attention today?", "How many organizer applications are pending?", "Which trips are waiting for review?"],
  MODERATOR: ["What is waiting for review?", "Show me the open disputes"],
  ORGANIZER: ["How are my trips doing?", "What does my passenger notice say?"],
  DRIVER: ["What is my queue like?", "Am I on a ride right now?"],
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

  return <div className="console-assistant">
    {open && <section className="console-assistant-panel" aria-label="Console assistant">
      <header>
        <span><Sparkles size={16}/> Console assistant</span>
        <button type="button" aria-label="Close assistant" onClick={() => setOpen(false)}><X size={17}/></button>
      </header>
      <div className="console-assistant-log" aria-live="polite">
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
    </button>
  </div>;
}
