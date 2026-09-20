"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Banknote, BusFront, CalendarClock, Clock3, TrendingUp, Users, Wallet } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

type Totals = { accrued: number; ready: number; released: number; reversed: number; debt: number; balance: number; entries: number };
type Entry = {
  id: string; bookingReference: string; title: string; from: string; to: string;
  grossAmount: number; commissionAmount: number; netAmount: number; commissionBps: number;
  releaseAfter: string; status: string; transferReference: string; releasedAt: string; lastError: string;
  reversedAt: string; reversedReason: string; createdAt: string;
};
type Batch = { id: string; totalAmount: number; entryCount: number; transferReference: string; note: string; createdAt: string };
type TripPerformance = {
  tripId: string; title: string; from: string; to: string; travelDate: string; departureTime: string;
  reviewStatus: string; active: boolean; capacity: number; booked: number; sellThrough: number;
  gross: number; commission: number; net: number; accrued: number; released: number;
};
type Insights = {
  trips: number; liveTrips: number; seatsOffered: number; seatsSold: number; sellThrough: number;
  gross: number; net: number; accrued: number; released: number;
  nextDeparture: { tripId: string; title: string; travelDate: string; departureTime: string; from: string; to: string } | null;
};
type Statement = { totals: Totals; entries: Entry[]; batches: Batch[] };

const cedis = (pesewas: number) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const percent = (value: number) => `${Math.round(Number(value || 0) * 100)}%`;

export default function OrganizerEarningsPage() {
  return <ConsoleSessionGate label="your earnings">
    {(session) => session.account.role === "ORGANIZER"
      ? <EarningsWorkspace session={session} />
      : <ConsoleUnavailable session={session} service="earnings" label="EARNINGS" blurb="This page belongs to an organizer account." />}
  </ConsoleSessionGate>;
}

function EarningsWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [trips, setTrips] = useState<TripPerformance[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/payouts/statement", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your statement could not be loaded.");
      setStatement(data.statement);
      setInsights(data.insights || null);
      setTrips(data.trips || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your statement could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(load); }, [load]);

  const totals = statement?.totals;
  return <ConsoleShell
    session={session}
    service="earnings"
    label="EARNINGS"
    title="What you have earned"
    blurb="Each fare is split into the platform commission and your share. A booking's payout becomes ready 24 hours after it was paid."
    actions={<Link href="/console/trips">My trips</Link>}
  >

    {error && <div className="console-alert" role="alert">{error}</div>}

    {totals && <section className="console-totals">
      <article><span><Wallet size={13}/> Balance</span><strong>{cedis(totals.balance)}</strong><small>{totals.debt > 0 ? "After a refunded payout" : "Owed to you today"}</small></article>
      <article><span><Clock3 size={13}/> Ready to pay</span><strong>{cedis(totals.ready)}</strong><small>Released after the trip</small></article>
      <article><span><Banknote size={13}/> Awaiting release</span><strong>{cedis(Math.max(0, totals.accrued - totals.ready))}</strong><small>Still inside the release gate</small></article>
      <article><span><Banknote size={13}/> Paid out</span><strong>{cedis(totals.released)}</strong><small>{statement?.batches.length || 0} payout{statement?.batches.length === 1 ? "" : "s"} recorded</small></article>
    </section>}

    {totals && totals.debt > 0 && <div className="console-alert" role="alert">
      <AlertTriangle size={15}/> A booking was refunded after its payout, so {cedis(totals.debt)} is carried against your next earnings.
    </div>}

    {insights && insights.trips > 0 && <section className="console-totals">
      <article><span><TrendingUp size={13}/> Seats sold</span><strong>{insights.seatsSold} / {insights.seatsOffered}</strong><small>{percent(insights.sellThrough)} of everything you published</small></article>
      <article><span><BusFront size={13}/> Live trips</span><strong>{insights.liveTrips}</strong><small>{insights.trips} published in total</small></article>
      <article><span><Wallet size={13}/> Fares earned</span><strong>{cedis(insights.gross)}</strong><small>{cedis(insights.net)} after commission</small></article>
      <article><span><CalendarClock size={13}/> Next departure</span><strong>{insights.nextDeparture ? when(insights.nextDeparture.travelDate) : "—"}</strong><small>{insights.nextDeparture ? `${insights.nextDeparture.from} → ${insights.nextDeparture.to} · ${insights.nextDeparture.departureTime}` : "Nothing scheduled ahead"}</small></article>
    </section>}

    {trips.length > 0 && <section className="console-panel">
      <h2><Users size={18}/>How each trip is selling</h2>
      <table className="console-table">
        <thead><tr><th>Trip</th><th>Departs</th><th>Seats</th><th>Sold</th><th>Fares</th><th>Your share</th></tr></thead>
        <tbody>
          {trips.map((trip) => (
            <tr key={trip.tripId}>
              <td>
                <span>{trip.from && trip.to ? `${trip.from} → ${trip.to}` : trip.title || "Trip"}</span>
                <small>{trip.reviewStatus}{trip.active ? " · live" : ""}</small>
              </td>
              <td><span>{when(trip.travelDate)}</span><small>{trip.departureTime || "—"}</small></td>
              <td>{trip.capacity}</td>
              <td>
                <strong>{trip.booked}</strong>
                <small>{trip.capacity > 0 ? percent(trip.sellThrough) : "no capacity set"}</small>
              </td>
              <td>{cedis(trip.gross)}</td>
              <td><strong>{cedis(trip.net)}</strong><small>{cedis(trip.released)} paid</small></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="console-note">
        Seats are confirmed bookings, and fares are what the ledger recorded for those bookings, so this table and your statement always agree.
        A trip with no capacity set shows no sell-through rather than a false 100%.
      </p>
    </section>}

    <section className="console-panel">
      <h2><Banknote size={18}/>Booking by booking</h2>
      {!statement || statement.entries.length === 0
        ? <p className="console-empty">Nothing yet. Earnings appear here as soon as a booking is confirmed.</p>
        : <table className="console-table">
          <thead><tr><th>Booking</th><th>Trip</th><th>Fare</th><th>Commission</th><th>You earn</th><th>Status</th></tr></thead>
          <tbody>
            {statement.entries.map((entry) => (
              <tr key={entry.id}>
                <td><span>{entry.bookingReference || "—"}</span><small>{when(entry.createdAt)}</small></td>
                <td><span>{entry.from && entry.to ? `${entry.from} → ${entry.to}` : entry.title || "Trip"}</span><small>Releases {when(entry.releaseAfter)}</small></td>
                <td>{cedis(entry.grossAmount)}</td>
                <td><span>{cedis(entry.commissionAmount)}</span><small>{(entry.commissionBps / 100).toFixed(2)}%</small></td>
                <td><strong>{cedis(entry.netAmount)}</strong></td>
                <td>
                  <span className={`console-badge console-badge-${entry.status.toLowerCase()}`}>{entry.status}</span>
                  {entry.transferReference && <small>Ref {entry.transferReference}</small>}
                  {entry.status === "FAILED" && <small className="console-reason">{entry.lastError || "The transfer could not be completed. The team has been alerted."}</small>}
                  {entry.reversedReason && <small className="console-reason">{entry.reversedReason}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

    <section className="console-panel">
      <h2><Banknote size={18}/>Payouts recorded</h2>
      {!statement || statement.batches.length === 0
        ? <p className="console-empty">No payout has been recorded yet.</p>
        : <table className="console-table">
          <thead><tr><th>Date</th><th>Transfer reference</th><th>Entries</th><th>Amount</th><th>Note</th></tr></thead>
          <tbody>
            {statement.batches.map((batch) => (
              <tr key={batch.id}>
                <td>{when(batch.createdAt)}</td>
                <td>{batch.transferReference || "—"}</td>
                <td>{batch.entryCount}</td>
                <td><strong>{cedis(batch.totalAmount)}</strong></td>
                <td>{batch.note || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>}
      <p className="console-note">
        Payouts go out automatically to the account on your profile once an entry passes its release date. If a statement looks wrong, contact the team with the booking reference.
      </p>
    </section>
  </ConsoleShell>;
}
