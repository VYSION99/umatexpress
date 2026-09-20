"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2, MessageSquareQuote, RefreshCw, Star } from "lucide-react";
import { Stars } from "@/components/campusRide/hostel/PropertyReviews";

type Review = {
  id: string; bookingId: string; propertyId: string; landlordId: string;
  studentName: string; studentEmail: string; rating: number; title: string; body: string;
  status: string; reply: string; replyBy: string; repliedAt: string; hiddenReason: string;
  moderatedBy: string; moderatedAt: string; createdAt: string;
};
type Summary = { count: number; published: number; hidden: number; average: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const FILTERS = ["ALL", "PUBLISHED", "HIDDEN"] as const;

/**
 * The reviews desk. A landlord answers the reviews left for their own
 * buildings; staff read every review, including the hidden ones, and hold the
 * only lever that changes what the public page shows.
 */
export function HostelReviewsPanel({ role }: { role: string }) {
  const isStaff = role === "ADMIN" || role === "MODERATOR";
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [hideReasons, setHideReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const query = isStaff && filter !== "ALL" ? `?status=${filter}` : "";
      const response = await fetch(`/api/console/hostel/reviews${query}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { reviews?: Review[]; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error || "The reviews could not be loaded.");
      setReviews(data.reviews || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The reviews could not be loaded.");
    }
  }, [filter, isStaff]);

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

  async function act(review: Review, action: "REPLY" | "HIDE" | "PUBLISH") {
    await run(async () => {
      setBusy(review.id);
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/reviews", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reviewId: review.id,
            action,
            reply: replies[review.id] || "",
            reason: hideReasons[review.id] || "",
          }),
        });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error || "That action did not work.");
        setNotice(action === "REPLY" ? "Your answer is on the review." : action === "HIDE" ? "The review is hidden from the public page." : "The review is public again.");
        setReplies((current) => ({ ...current, [review.id]: "" }));
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  if (!reviews) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading reviews…</p>;

  return <section className="console-panel">
    <h2><Star size={18} aria-hidden />Reviews
      {summary && <span className="console-badge">{summary.count}</span>}
      <button type="button" className="console-panel-close" onClick={() => void run(load)}><RefreshCw size={14} aria-hidden />Refresh</button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    {summary && <p className="console-note">
      {summary.count === 0
        ? "No resident has reviewed this hostel yet."
        : `${summary.published} published · ${summary.hidden} hidden · average ${summary.average.toFixed(1)} out of 5.`}
    </p>}
    {isStaff && <div className="console-toolbar">
      {FILTERS.map((option) => <button
        key={option}
        type="button"
        className={filter === option ? "is-active" : ""}
        onClick={() => setFilter(option)}
      >{option === "ALL" ? "All reviews" : option === "PUBLISHED" ? "Published" : "Hidden"}</button>)}
    </div>}
    {reviews.length === 0
      ? <p className="console-empty">Nothing to show under this filter.</p>
      : <ul className="console-reviews">
        {reviews.map((review) => <li key={review.id}>
          <header>
            <Stars rating={review.rating} />
            <strong>{review.title || `${review.rating} out of 5`}</strong>
            <span className={`console-badge console-badge-${review.status === "PUBLISHED" ? "approved" : "dismissed"}`}>{review.status === "PUBLISHED" ? "Public" : "Hidden"}</span>
            <small>{review.studentName || "A resident"} · {when(review.createdAt)}</small>
          </header>
          <p>{review.body}</p>
          {review.status === "HIDDEN" && <p className="console-reason">Hidden by {review.moderatedBy || "staff"}{review.hiddenReason ? `: ${review.hiddenReason}` : ""}</p>}
          {review.reply
            ? <div className="console-review-reply"><MessageSquareQuote size={14} aria-hidden /><div>
              <strong>Answered{review.replyBy ? ` by ${review.replyBy}` : ""}</strong>
              <span>{review.reply}</span>
            </div></div>
            : !isStaff && <form className="console-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void act(review, "REPLY"); }}>
              <label className="console-field-wide">Answer this review
                <textarea value={replies[review.id] || ""} onChange={(event) => setReplies((current) => ({ ...current, [review.id]: event.target.value }))} maxLength={1500} rows={2} placeholder="Thank them, or explain what changed." />
              </label>
              <button type="submit" disabled={busy === review.id || !(replies[review.id] || "").trim()}>
                {busy === review.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <MessageSquareQuote size={14} aria-hidden />} Send reply
              </button>
            </form>}
          {isStaff && <div className="console-row-actions">
            {review.status === "PUBLISHED"
              ? <>
                <input type="text" value={hideReasons[review.id] || ""} onChange={(event) => setHideReasons((current) => ({ ...current, [review.id]: event.target.value }))} placeholder="Why hide it?" maxLength={300} />
                <button type="button" className="console-secondary" disabled={busy === review.id || !(hideReasons[review.id] || "").trim()} onClick={() => void act(review, "HIDE")}>
                  {busy === review.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <EyeOff size={14} aria-hidden />} Hide
                </button>
              </>
              : <button type="button" className="console-secondary" disabled={busy === review.id} onClick={() => void act(review, "PUBLISH")}>
                {busy === review.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <Eye size={14} aria-hidden />} Publish again
              </button>}
          </div>}
        </li>)}
      </ul>}
  </section>;
}
