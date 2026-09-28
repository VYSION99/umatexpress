"use client";

import { useState } from "react";
import { CircleNotch, Question, Sparkle } from "@phosphor-icons/react";

const SUGGESTIONS = [
  "How much is the cheapest bed this year?",
  "How far is it from campus?",
  "What do students say about this place?",
];

/**
 * The public "ask about this hostel" card. Every answer is written from the
 * listing's own page — the beds on sale, the prices, the distance and the
 * published reviews — so it can help a student compare without ever inventing
 * a fact or promising a bed.
 */
export function PropertyAssistant({ propertyId, propertyName }: { propertyId: string; propertyName: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const [needsStaff, setNeedsStaff] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [contact, setContact] = useState({ name: "", email: "" });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function ask(text: string) {
    const value = text.trim();
    if (!value) return;
    setAsking(true);
    setError("");
    setAnswer(""); setNeedsStaff(false); setHandoffOpen(false); setSent(false);
    try {
      const response = await fetch("/api/hostel/ask", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ propertyId, question: value }),
      });
      const data = await response.json() as { answer?: string; needsStaff?: boolean; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error || "That question could not be answered.");
      setAnswer(data.answer); setNeedsStaff(Boolean(data.needsStaff)); setHandoffOpen(Boolean(data.needsStaff));
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "That question could not be answered.");
    } finally {
      setAsking(false);
    }
  }

  async function sendToStaff(event: React.FormEvent) {
    event.preventDefault(); setSending(true); setError("");
    try {
      const response = await fetch("/api/hostel/inquiries", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, question, name: contact.name, email: contact.email, assistantAnswer: answer }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Your question could not be sent.");
      setSent(true); setHandoffOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your question could not be sent."); }
    finally { setSending(false); }
  }

  return <section className="hostel-assistant">
    <p><Sparkle size={13} aria-hidden /> ASK ABOUT THIS HOSTEL</p>
    <form onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
      <textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder={`What would you like to know about ${propertyName}?`}
        maxLength={500}
        rows={2}
      />
      <button type="submit" disabled={asking || question.trim().length < 3}>
        {asking ? <CircleNotch size={14} className="console-spin" aria-hidden /> : <Question size={14} aria-hidden />} Ask
      </button>
    </form>
    {!answer && !asking && <div className="hostel-assistant-chips">
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setQuestion(suggestion); void ask(suggestion); }}>{suggestion}</button>)}
    </div>}
    {answer && <div className="hostel-assistant-answer">
      <p>{answer}</p>
      <small>Based on the public listing and information supplied by the hostel. Confirm changing details before paying.</small>
      {!sent && <button type="button" className="hostel-assistant-handoff" onClick={() => setHandoffOpen(open => !open)}>{needsStaff ? "Send this question to hostel staff" : "Need more detail? Ask hostel staff"}</button>}
    </div>}
    {handoffOpen && answer && !sent && <form className="hostel-assistant-contact" onSubmit={event => void sendToStaff(event)}><p>Hostel staff can answer your specific question by email.</p><label>Your name<input required minLength={2} maxLength={100} value={contact.name} onChange={event => setContact({ ...contact, name: event.target.value })}/></label><label>Email for the reply<input required type="email" value={contact.email} onChange={event => setContact({ ...contact, email: event.target.value })}/></label><button type="submit" disabled={sending}>{sending ? "Sending…" : "Send to hostel staff"}</button></form>}
    {sent && <p className="hostel-assistant-sent" role="status">Your question is in the hostel staff inbox. Their reply will be emailed to you.</p>}
    {error && <span className="hostel-book-error">{error}</span>}
  </section>;
}
