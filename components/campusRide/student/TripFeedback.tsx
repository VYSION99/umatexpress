"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CheckCircle2, Flag, Loader2, Star } from "lucide-react";

type FeedbackState = {
  completed: boolean;
  canRate: boolean;
  canReport: boolean;
  rating: { rating: number; comment: string; updatedAt: string } | null;
};

const SCORES = [
  { value: 1, label: "Bad" },
  { value: 2, label: "Poor" },
  { value: 3, label: "Fine" },
  { value: 4, label: "Good" },
  { value: 5, label: "Great" },
];

const REPORT_CATEGORIES = [
  { value: "DELAY", label: "The trip was late" },
  { value: "CONDUCT", label: "The driver's conduct" },
  { value: "PAYMENT", label: "The payment" },
  { value: "TRIP_CANCELLED", label: "The trip was cancelled" },
  { value: "OTHER", label: "Something else" },
];

/**
 * The two things a passenger gets to say after a trip, and they are different
 * things: a score, which the driver sees as a running average, and a complaint,
 * which a person has to read and answer.
 *
 * The report is deliberately one field. Someone who is upset should not have to
 * also invent a title for their own complaint, so the category they pick becomes
 * the subject and they only write what happened.
 */
export function TripFeedback({ reference }: { reference: string }) {
  const [state, setState] = useState<FeedbackState | null>(null);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [category, setCategory] = useState("DELAY");
  const [details, setDetails] = useState("");
  // `role="radio"` promises arrow-key navigation, so the group keeps a roving
  // tab stop: one star is reachable by Tab and the arrows move between them.
  const stars = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!reference) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/campus/feedback?reference=${encodeURIComponent(reference)}`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as FeedbackState;
        if (!active) return;
        setState(data);
        setScore(Number(data.rating?.rating || 0));
        setComment(String(data.rating?.comment || ""));
      } catch { /* the ticket still works without the feedback panel */ }
    })();
    return () => { active = false; };
  }, [reference]);

  const focusScore = (value: number) => {
    const next = Math.min(SCORES.length, Math.max(1, value));
    setScore(next);
    stars.current[next - 1]?.focus();
  };

  const onRatingKey = (event: KeyboardEvent<HTMLButtonElement>, value: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step) { event.preventDefault(); focusScore(value + step); return; }
    if (event.key === "Home") { event.preventDefault(); focusScore(1); }
    if (event.key === "End") { event.preventDefault(); focusScore(SCORES.length); }
  };

  const saveRating = async () => {
    setBusy("rating"); setMessage(""); setError("");
    try {
      const response = await fetch("/api/campus/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference, kind: "RATING", rating: score, comment }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That rating could not be saved.");
      setMessage("Thanks — that is on the driver's record.");
    } catch (ratingError) {
      setError(ratingError instanceof Error ? ratingError.message : "That rating could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const sendReport = async () => {
    setBusy("report"); setMessage(""); setError("");
    try {
      const response = await fetch("/api/campus/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference, kind: "REPORT", category, details }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That report could not be sent.");
      setState((current) => current ? { ...current, canReport: false } : current);
      setReportOpen(false);
      setMessage("Reported. Operations will read it and come back to you.");
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "That report could not be sent.");
    } finally {
      setBusy("");
    }
  };

  // A trip that is still running has nothing to rate, and an unread seat has
  // nothing to say: the panel only appears once the trip is over.
  if (!state?.completed) return null;

  return <section className="campus-feedback-panel">
    <div className="campus-feedback-head">
      <div>
        <p>HOW WAS THE RIDE?</p>
        <h2>{state.rating ? "Your rating" : "Rate this trip"}</h2>
        <span>{state.rating ? "You can change this until the day ends." : "One tap. The driver sees their average, never a single review."}</span>
      </div>
      <div className="campus-rating" role="radiogroup" aria-label="Trip rating">
        {SCORES.map((option) => <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={score === option.value}
          aria-label={option.label}
          tabIndex={score ? (score === option.value ? 0 : -1) : (option.value === 1 ? 0 : -1)}
          ref={(node) => { stars.current[option.value - 1] = node; }}
          className={score >= option.value ? "is-on" : ""}
          onKeyDown={(event) => onRatingKey(event, option.value)}
          onClick={() => setScore(option.value)}
        ><Star size={20}/></button>)}
        {score > 0 && <small>{SCORES[score - 1].label}</small>}
      </div>
    </div>

    {state.canRate ? <div className="campus-feedback-actions">
      <input
        type="text"
        value={comment}
        maxLength={200}
        placeholder="Add a line, if you like"
        aria-label="Comment about the trip"
        onChange={(event) => setComment(event.target.value)}
      />
      <button type="button" onClick={saveRating} disabled={!score || busy === "rating"}>
        {busy === "rating" ? <><Loader2 size={15} className="spin"/>Saving…</> : "Submit rating"}
      </button>
      {state.canReport ? (reportOpen
        ? null
        : <button type="button" className="campus-report-button" onClick={() => setReportOpen(true)}><Flag size={15}/>Something went wrong</button>)
        : null}
    </div> : null}

    {reportOpen && <form className="campus-report-form" onSubmit={(event) => { event.preventDefault(); void sendReport(); }}>
      <strong>What happened?</strong>
      <small>This goes to a person, not to the driver. Tell us what they need to know.</small>
      <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="What kind of problem">
        {REPORT_CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <textarea
        required
        rows={4}
        minLength={20}
        maxLength={2000}
        value={details}
        placeholder="Describe it in a sentence or two — what happened, and when."
        aria-label="What happened"
        onChange={(event) => setDetails(event.target.value)}
      />
      <div>
        <button type="submit" disabled={busy === "report"}>{busy === "report" ? <><Loader2 size={15} className="spin"/>Sending…</> : "Send report"}</button>
        <button type="button" onClick={() => setReportOpen(false)}>Cancel</button>
      </div>
    </form>}

    {message && <p className="campus-feedback-message"><CheckCircle2 size={15}/>{message}</p>}
    {error && <p className="campus-feedback-error">{error}</p>}
  </section>;
}
