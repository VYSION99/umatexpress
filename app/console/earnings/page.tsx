"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Banknote, BusFront, Clock3, LogOut, Store, Wallet } from "lucide-react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";

type Totals = { accrued: number; ready: number; released: number; reversed: number; debt: number; balance: number; entries: number };
type Entry = {
  id: string; bookingReference: string; title: string; from: string; to: string;
  grossAmount: number; commissionAmount: number; netAmount: number; commissionBps: number;
  releaseAfter: string; status: string; transferReference: string; releasedAt: string;
  reversedAt: string; reversedReason: string; createdAt: string;
};
type Batch = { id: string; totalAmount: number; entryCount: number; transferReference: string; note: string; createdAt: string };
type Statement = { totals: Totals; entries: Entry[]; batches: Batch[] };

const cedis = (pesewas: number) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

export default function OrganizerEarningsPage() {
  return <ConsoleSessionGate label="your earnings">
    {(session) => session.account.role === "ORGANIZER"
      ? <EarningsWorkspace />
      : <main className="console-page"><section className="console-hero"><h1>Not available</h1><span>This page belongs to an organizer account.</span></section></main>}
  </ConsoleSessionGate>;
}

function EarningsWorkspace() {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/payouts/statement", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your statement could not be loaded.");
      setStatement(data.statement);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your statement could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(load); }, [load]);

  const totals = statement?.totals;
  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><Store size={15}/>Organizer</span>
        <Link href="/console/trips"><BusFront size={16}/>My trips</Link>
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>EARNINGS</p>
      <h1>What you have earned</h1>
      <span>Each fare is split into the platform commission and your share. A payout releases after midnight following the trip.</span>
    </section>

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
        Payouts are recorded by the UMaTeXPRESS team once the transfer is made. If a statement looks wrong, contact the team with the booking reference.
      </p>
    </section>
  </main>;
}
