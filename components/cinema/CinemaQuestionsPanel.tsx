"use client";

import { useCallback, useEffect, useState } from "react";
import type { CinemaDiscussionQuestion } from "@/lib/cinema-engine/questions";

export function CinemaQuestionsPanel({ roomId, canManage }: { roomId: string; canManage: boolean }) {
  const [questions, setQuestions] = useState<CinemaDiscussionQuestion[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/cinema/sessions/${roomId}/questions`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json() as { questions?: CinemaDiscussionQuestion[] };
    setQuestions(data.questions || []);
  }, [roomId]);
  useEffect(() => { queueMicrotask(() => void load()); const timer = setInterval(() => { if (!document.hidden) void load(); }, 25_000 + Math.floor(Math.random() * 5_000)); return () => clearInterval(timer); }, [load]);
  const act = async (body: Record<string, unknown>, method: "POST" | "PATCH") => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/questions`, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The question could not be saved.");
      if (method === "POST") setDraft("");
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The question could not be saved."); }
    finally { setBusy(false); }
  };
  return <div className="cinema-discussion-questions">
    <p className="cinema-note">Questions appear to the audience after the host approves them.</p>
    <form onSubmit={(event) => { event.preventDefault(); void act({ text: draft }, "POST"); }}>
      <label htmlFor="cinema-question-draft">Ask the panel</label>
      <textarea id="cinema-question-draft" rows={3} maxLength={400} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="What would you like the speakers to address?" />
      <button disabled={busy || draft.trim().length < 5}>Submit question</button>
    </form>
    {error && <p className="cinema-error" role="alert">{error}</p>}
    <ul className="cinema-question-list">
      {questions.map((question) => <li key={question.id} className={`is-${question.status.toLowerCase()}`}>
        <div><strong>{question.displayName}</strong><span>{question.status === "PENDING" ? "Awaiting review" : question.status === "APPROVED" ? "For the panel" : question.status === "ANSWERED" ? "Answered" : "Dismissed"}</span></div>
        <p>{question.text}</p>
        {canManage && question.status !== "DISMISSED" && <div className="cinema-question-actions">
          {question.status === "PENDING" && <button disabled={busy} onClick={() => void act({ questionId: question.id, status: "APPROVED" }, "PATCH")}>Show audience</button>}
          {question.status === "APPROVED" && <button disabled={busy} onClick={() => void act({ questionId: question.id, status: "ANSWERED" }, "PATCH")}>Mark answered</button>}
          <button className="secondary" disabled={busy} onClick={() => void act({ questionId: question.id, status: "DISMISSED" }, "PATCH")}>Dismiss</button>
        </div>}
      </li>)}
    </ul>
    {!questions.length && <p className="cinema-note">No questions yet.</p>}
  </div>;
}
