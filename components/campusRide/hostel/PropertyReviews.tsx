"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquareQuote, Star } from "lucide-react";

type Review = {
  id: string; rating: number; title: string; body: string; studentName: string;
  createdAt: string; reply: string; repliedAt: string;
};
type Summary = { average: number; count: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

/** Five stars, filled to the rounded score. Read aloud by the label. */
export function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  const rounded = Math.round(Number(rating) || 0);
  return <span className="hostel-stars" role="img" aria-label={`${Number(rating || 0).toFixed(1)} out of 5`}>
    {[1, 2, 3, 4, 5].map((step) => <Star key={step} size={size} aria-hidden className={step <= rounded ? "is-on" : ""} />)}
  </span>;
}

/**
 * What residents said about this building. Only a student with a paid booking
 * can add one, so the score is anchored to stays that actually happened; the
 * page never offers a box a visitor could type into.
 */
export function PropertyReviews({ propertyId }: { propertyId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/api/hostel/reviews?propertyId=${encodeURIComponent(propertyId)}`, { cache: "no-store" });
      const data = await response.json() as { summary?: Summary; reviews?: Review[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The reviews could not be loaded.");
      setSummary(data.summary || { average: 0, count: 0 });
      setReviews(data.reviews || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The reviews could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  if (loading) return <section className="hostel-reviews"><p className="hostel-resident-muted"><Loader2 size={14} className="console-spin" aria-hidden /> Reading what residents said…</p></section>;
  if (error) return <section className="hostel-reviews"><p className="hostel-book-error">{error}</p></section>;

  return <section className="hostel-reviews">
    <div className="hostel-results-head">
      <h2>What residents said</h2>
      {summary && summary.count > 0 && <span className="hostel-review-score"><Stars rating={summary.average} />{summary.average.toFixed(1)} · {summary.count} {summary.count === 1 ? "review" : "reviews"}</span>}
    </div>
    {reviews.length === 0
      ? <p className="hostel-resident-muted">No review yet. The first student to pay for a bed here can write one from their resident page.</p>
      : <ul className="hostel-review-list">
        {reviews.map((review) => <li key={review.id}>
          <header>
            <Stars rating={review.rating} />
            <strong>{review.title || `${review.rating} out of 5`}</strong>
            <small>{review.studentName || "A resident"} · {when(review.createdAt)}</small>
          </header>
          <p>{review.body}</p>
          {review.reply && <div className="hostel-review-reply">
            <MessageSquareQuote size={14} aria-hidden />
            <div>
              <strong>The hostel replied</strong>
              <span>{review.reply}</span>
              <small>{when(review.repliedAt)}</small>
            </div>
          </div>}
        </li>)}
      </ul>}
  </section>;
}
