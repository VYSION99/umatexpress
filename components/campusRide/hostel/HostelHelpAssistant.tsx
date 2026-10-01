"use client";
import { useState, type FormEvent } from "react";
import { PaperPlaneTilt, Sparkle } from "@phosphor-icons/react";

const PROMPTS = ["How do I renew or change my room?", "How do I record my room condition?", "How do I report a maintenance problem?"];
export function HostelHelpAssistant({ staff = false }: { staff?: boolean }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(false);
  async function ask(value = question) {
    if (value.trim().length < 3 || busy) return;
    setBusy(true); setError(""); setAnswer("");
    try {
      const response = await fetch(staff ? "/api/console/hostel/help" : "/api/hostel/help", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: value }),
      });
      const data = await response.json() as { answer?: string; configured?: boolean; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error || "The help assistant could not answer.");
      setAnswer(data.answer); setFallback(!data.configured);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The help assistant could not answer."); }
    finally { setBusy(false); }
  }
  return <section className="hostel-guide-ai" aria-labelledby={staff ? "hostel-staff-ai-title" : "hostel-student-ai-title"}>
    <div className="hostel-guide-ai-heading"><span><Sparkle size={16}/> {staff ? "STAFF GUIDE ASSISTANT" : "STUDENT HELP ASSISTANT"}</span><h2 id={staff ? "hostel-staff-ai-title" : "hostel-student-ai-title"}>Ask about Hostel Finder</h2><p>{staff ? "Answers use the current procedures for your signed-in console role. The assistant cannot change records." : "Answers come from Hostel Finder’s student help guide. For one property, ask its property assistant."}</p></div>
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); void ask(); }}>
      <label htmlFor={staff ? "hostel-staff-question" : "hostel-student-question"}>Your question</label>
      <div className="hostel-guide-ai-input"><input id={staff ? "hostel-staff-question" : "hostel-student-question"} maxLength={500} value={question} onChange={event => setQuestion(event.target.value)} placeholder={staff ? "How do I review a new property?" : "How does booking or a refund work?"}/><button type="submit" disabled={busy || question.trim().length < 3} aria-label="Ask"><PaperPlaneTilt size={17}/>{busy ? "Thinking…" : "Ask"}</button></div>
    </form>
    {!answer && <div className="hostel-guide-ai-prompts">{(staff ? ["How do I manage renewals and room changes?", "How do I review a room condition record?", "How do I manage maintenance reports?"] : PROMPTS).map(item => <button type="button" key={item} disabled={busy} onClick={() => { setQuestion(item); void ask(item); }}>{item}</button>)}</div>}
    {answer && <div className="hostel-guide-ai-answer" role="status"><p>{answer}</p>{fallback && <small>Guide response; live AI is unavailable on this deployment.</small>}</div>}
    {error && <p className="hostel-guide-ai-error" role="alert">{error}</p>}
  </section>;
}
