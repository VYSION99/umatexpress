"use client";

import { useCallback, useEffect, useState } from "react";
import { BedDouble, Building2, BusFront, Loader2, RefreshCw, Star, Wallet } from "lucide-react";
import { cedis } from "@/components/campusRide/hostel/format";

type Analytics = {
  generatedAt: string;
  occupancy: { occupied: number; available: number; total: number; rate: number };
  bookings: {
    total: number; paid: number; pendingPayment: number; paymentReview: number;
    expired: number; cancelled: number; refunded: number;
    paidValue: number; refundedValue: number;
    trend: { day: string; count: number; amount: number }[];
    distinctStudents: number; repeatStudents: number;
  };
  listings: { approved: number; pendingReview: number; draft: number; suspended: number; total: number };
  properties: { active: number; draft: number; suspended: number; total: number };
  landlords: { total: number; verified: number; pendingKyc: number; rejected: number };
  money: { gross: number; commission: number; net: number; accrued: number; released: number; processing: number; reversed: number };
  reviews: { count: number; average: number; hidden: number };
  messages: { threads: number; recent: number };
  topProperties: { id: string; name: string; bookings: number; revenue: number; ratingAverage: number; ratingCount: number }[];
};

const percent = (value: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * The admin's hostel scoreboard. Every number is a read of a ledger the
 * operational screens already write, so this page is presentation only.
 */
export function HostelAnalytics() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/console/hostel/analytics", { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json() as { analytics?: Analytics; error?: string };
      if (!response.ok || !payload.analytics) throw new Error(payload.error || "The analytics could not be loaded.");
      setData(payload.analytics);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The analytics could not be loaded.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  if (error) return <section className="console-panel"><div className="console-alert" role="alert">{error}</div></section>;
  if (!data) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Counting the year…</p>;

  const peak = Math.max(1, ...data.bookings.trend.map((day) => day.amount));

  return <>
    <section className="console-totals">
      <article><span><BedDouble size={12} aria-hidden />BEDS FILLED</span><strong>{percent(data.occupancy.rate)}</strong><small>{data.occupancy.occupied} of {data.occupancy.total} bed spaces</small></article>
      <article><span><BusFront size={12} aria-hidden />PAID BOOKINGS</span><strong>{data.bookings.paid}</strong><small>{cedis(data.bookings.paidValue)} collected · {data.bookings.distinctStudents} students</small></article>
      <article><span><Wallet size={12} aria-hidden />LANDLORD SHARE</span><strong>{cedis(data.money.net)}</strong><small>{cedis(data.money.released)} released · {cedis(data.money.accrued)} held</small></article>
      <article><span><Building2 size={12} aria-hidden />PLATFORM 3%</span><strong>{cedis(data.money.commission)}</strong><small>on {cedis(data.money.gross)} of bed rent</small></article>
    </section>

    <section className="console-panel">
      <h2><BusFront size={18} aria-hidden />Paid bookings, last 14 days
        <button type="button" className="console-panel-close" onClick={() => void load()}><RefreshCw size={14} aria-hidden />Refresh</button>
      </h2>
      <ul className="console-chart" aria-label="Paid bookings per day">
        {data.bookings.trend.map((day) => <li key={day.day}>
          <div className="console-chart-bar">
            <span style={{ height: `${Math.round((day.amount / peak) * 100)}%` }} title={`${cedis(day.amount)} · ${day.count} booking${day.count === 1 ? "" : "s"}`} />
          </div>
          <small>{shortDay(day.day)}</small>
        </li>)}
      </ul>
      <p className="console-note">Tallest day {cedis(peak)}. {data.bookings.pendingPayment} beds are held awaiting payment, {data.bookings.expired} have expired and {data.bookings.cancelled + data.bookings.refunded} are closed.</p>
    </section>

    <section className="console-panel">
      <h2><Building2 size={18} aria-hidden />Buildings carrying the year</h2>
      {data.topProperties.length === 0
        ? <p className="console-empty">No paid booking yet.</p>
        : <table className="console-table">
          <thead><tr><th>Property</th><th>Paid beds</th><th>Collected</th><th>Rating</th></tr></thead>
          <tbody>
            {data.topProperties.map((property) => <tr key={property.id}>
              <td><strong>{property.name}</strong></td>
              <td>{property.bookings}</td>
              <td><strong>{cedis(property.revenue)}</strong></td>
              <td>{property.ratingCount > 0
                ? <><span className="console-badge console-badge-approved"><Star size={11} aria-hidden />{property.ratingAverage.toFixed(1)}</span><small>{property.ratingCount} reviews</small></>
                : <small>No reviews yet</small>}</td>
            </tr>)}
          </tbody>
        </table>}
    </section>

    <section className="console-panel">
      <h2>Supply and trust</h2>
      <div className="console-stat-grid">
        <article><span>LISTINGS</span><strong>{data.listings.approved} live</strong><small>{data.listings.pendingReview} awaiting review · {data.listings.draft} draft · {data.listings.suspended} suspended</small></article>
        <article><span>BUILDINGS</span><strong>{data.properties.active} active</strong><small>{data.properties.draft} draft · {data.properties.suspended} suspended</small></article>
        <article><span>LANDLORDS</span><strong>{data.landlords.verified} verified</strong><small>{data.landlords.pendingKyc} pending KYC · {data.landlords.rejected} rejected</small></article>
        <article><span>RESIDENTS &amp; TALK</span><strong>{data.bookings.distinctStudents} students</strong><small>{data.bookings.repeatStudents} booked twice · {data.messages.threads} threads · {data.messages.recent} messages this week</small></article>
        <article><span>REVIEWS</span><strong>{data.reviews.count ? data.reviews.average.toFixed(1) : "—"} / 5</strong><small>{data.reviews.count} written · {data.reviews.hidden} hidden by staff</small></article>
        <article><span>MONEY OUT</span><strong>{cedis(data.money.released)}</strong><small>{cedis(data.money.processing)} in flight · {cedis(data.money.reversed)} reversed</small></article>
      </div>
    </section>
  </>;
}
