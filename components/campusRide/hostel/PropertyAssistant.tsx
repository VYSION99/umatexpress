"use client";

import { useState } from "react";
import { Loader2, MessageCircleQuestion, Sparkles } from "lucide-react";

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

  async function ask(text: string) {
    const value = text.trim();
    if (!value) return;
    setAsking(true);
    setError("");
    setAnswer("");
    try {
      const response = await fetch("/api/hostel/ask", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ propertyId, question: value }),
      });
      const data = await response.json() as { answer?: string; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error || "That question could not be answered.");
      setAnswer(data.answer);
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "That question could not be answered.");
    } finally {
      setAsking(false);
    }
  }

  return <section className="hostel-assistant">
    <p><Sparkles size={13} aria-hidden /> ASK ABOUT THIS HOSTEL</p>
    <form onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
      <textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder={`What would you like to know about ${propertyName}?`}
        maxLength={500}
        rows={2}
      />
      <button type="submit" disabled={asking || question.trim().length < 3}>
        {asking ? <Loader2 size={14} className="console-spin" aria-hidden /> : <MessageCircleQuestion size={14} aria-hidden />} Ask
      </button>
    </form>
    {!answer && !asking && <div className="hostel-assistant-chips">
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setQuestion(suggestion); void ask(suggestion); }}>{suggestion}</button>)}
    </div>}
    {answer && <div className="hostel-assistant-answer">
      <p>{answer}</p>
      <small>Answered from this listing. Anything else, message the hostel after you book.</small>
    </div>}
    {error && <span className="hostel-book-error">{error}</span>}
  </section>;
}
