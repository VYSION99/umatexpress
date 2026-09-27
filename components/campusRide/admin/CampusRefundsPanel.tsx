"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise, ArrowsClockwise, ArrowUUpLeft, Money, SealCheck, Wallet } from "@phosphor-icons/react";

type Refund = {
  id: string; reference: string; paymentReference: string; passengerEmail: string;
  amount: number; fareAmount: number; feeAmount: number; absorbedFee: number;
  policy: string; cause: string; reason: string; status: string;
  requestedBy: string; decidedBy: string; decidedAt: string;
  paystackReference: string; providerStatus: string; settledAt: string; createdAt: string;
};

type Summary = { total: number; requested: number; approved: number; paid: number; declined: number; failed: number; paidAmount: number };

const FILTERS = ["", "REQUESTED", "APPROVED", "PAID", "FAILED", "DECLINED"] as const;

const cedis = (pesewas: number) => `GH₵ ${(Math.max(0, Number(pesewas) || 0) / 100).toFixed(2)}`;
const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const badge = (status: string) => `console-badge console-badge-${String(status || "").toLowerCase()}`;

/**
 * The campus refund desk.
 *
 * A cancelled seat is the passenger's decision; sending the money back is an
 * administrator's. Every row is a fare the cancellation policy says is owed —
 * the desk only decides whether and how it leaves, and the reason is kept with
 * the row so the next person to look at it can see why.
 */
export function CampusRefundsPanel() {
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("REQUESTED");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async (status: string = filter) => {
    try {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const response = await fetch(`/api/console/campus/refunds${query}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Campus refunds could not be loaded.");
      setRefunds(data.refunds || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Campus refunds could not be loaded.");
    }
  }, [filter]);

  useEffect(() => { queueMicrotask(() => void load(filter)); }, [load, filter]);

  async function act(action: "APPROVE" | "DECLINE" | "RECORD" | "RECONCILE" | "SWEEP", refund?: Refund) {
    const key = refund ? `${refund.id}-${action}` : action;
    setBusy(key); setError(""); setSaved("");
    try {
      const response = await fetch("/api/console/campus/refunds", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          refundId: refund?.id,
          reason: refund ? notes[refund.id] || "" : "",
          note: refund ? notes[refund.id] || "" : "",
          reference: refund ? notes[refund.id] || "" : "",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That refund action could not be completed.");
      if (action === "APPROVE") setSaved(`${cedis(refund!.amount)} sent to ${refund!.passengerEmail}. Paystack settles it from here.`);
      if (action === "DECLINE") setSaved(`Refund declined and the passenger told.`);
      if (action === "RECORD") setSaved(`Recorded as paid under ${notes[refund!.id]}.`);
      if (action === "RECONCILE") setSaved(`Checked ${data.result?.checked ?? 0} pending refunds with Paystack.`);
      if (action === "SWEEP") setSaved(`Swept unmatched seats: ${data.result?.refunded ?? 0} refunded, ${data.result?.released ?? 0} seats released.`);
      if (refund) setNotes((current) => ({ ...current, [refund.id]: "" }));
      await load(filter);
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : "That refund action could not be completed.");
    } finally {
      setBusy("");
    }
  }

  const rows = useMemo(() => refunds || [], [refunds]);

  return <section className="campus-admin-control">
    <div className="campus-admin-control-head">
      <div>
        <p>CAMPUS REFUNDS</p>
        <h2>Fares owed back to students</h2>
      </div>
      <button type="button" onClick={() => void load(filter)} disabled={busy === "refresh"}>
        <ArrowsClockwise size={15} />Refresh
      </button>
    </div>
    {saved && <small className="campus-admin-message">{saved}</small>}
    {error && <small className="campus-admin-error">{error}</small>}

    {summary && <div className="console-stat-row">
      <span><small>Waiting</small><strong>{summary.requested}</strong></span>
      <span><small>Sent</small><strong>{summary.approved}</strong></span>
      <span><small>Paid</small><strong>{summary.paid}</strong></span>
      <span><small>Declined</small><strong>{summary.declined}</strong></span>
      <span><small>Returned to students</small><strong>{cedis(summary.paidAmount)}</strong></span>
    </div>}

    <section className="console-panel">
      <h2><ArrowUUpLeft size={18}/>Refund queue
        {refunds && <span className="console-badge">{rows.length}</span>}
      </h2>
      <div className="console-row-actions">
        {FILTERS.map((status) => <button
          key={status || "all"}
          type="button"
          className={filter === status ? "is-current" : ""}
          onClick={() => setFilter(status)}
        >{status || "All"}</button>)}
        <button type="button" disabled={busy === "SWEEP"} onClick={() => void act("SWEEP")}>
          <Wallet size={15}/>Sweep unmatched seats
        </button>
        <button type="button" disabled={busy === "RECONCILE"} onClick={() => void act("RECONCILE")}>
          <ArrowCounterClockwise size={15}/>Ask Paystack
        </button>
      </div>
      {!refunds
        ? <p className="console-empty">Loading campus refunds…</p>
        : rows.length === 0
          ? <p className="console-empty">Nothing here. A student cancelling a paid seat, or a sweep finding one nobody took, lands in this queue.</p>
          : <table className="console-table">
            <thead><tr><th>Passenger</th><th>Fare</th><th>Why</th><th>Status</th><th>Decision</th></tr></thead>
            <tbody>
              {rows.map((refund) => <tr key={refund.id}>
                <td>
                  <strong>{refund.passengerEmail || "unknown"}</strong>
                  <small>{refund.reference}</small>
                </td>
                <td>
                  <strong>{cedis(refund.amount)}</strong>
                  <small>fare {cedis(refund.fareAmount)} · fee {cedis(refund.feeAmount)}</small>
                </td>
                <td>
                  <span>{refund.policy} · {refund.cause}</span>
                  <small>{refund.reason || "no reason recorded"}</small>
                </td>
                <td>
                  <span className={badge(refund.status)}>{refund.status}</span>
                  <small>{refund.status === "PAID" ? when(refund.settledAt) : refund.decidedBy ? `by ${refund.decidedBy}` : when(refund.createdAt)}</small>
                  {refund.providerStatus && <small title={refund.providerStatus}>{String(refund.providerStatus).slice(0, 40)}</small>}
                </td>
                <td className="console-row-actions">
                  {refund.status === "REQUESTED" ? <>
                    <input
                      type="text"
                      aria-label={`Note for ${refund.reference}`}
                      placeholder="Note (needed to decline)"
                      maxLength={200}
                      value={notes[refund.id] || ""}
                      onChange={(event) => setNotes({ ...notes, [refund.id]: event.target.value })}
                    />
                    <button type="button" disabled={busy === `${refund.id}-APPROVE`} onClick={() => void act("APPROVE", refund)}>
                      <SealCheck size={15}/>Approve &amp; send
                    </button>
                    <button type="button" disabled={busy === `${refund.id}-DECLINE`} onClick={() => void act("DECLINE", refund)}>
                      <ArrowUUpLeft size={15}/>Decline
                    </button>
                  </> : refund.status === "APPROVED" || refund.status === "FAILED" ? <>
                    <input
                      type="text"
                      aria-label={`Transfer reference for ${refund.reference}`}
                      placeholder="Transfer reference"
                      maxLength={80}
                      value={notes[refund.id] || ""}
                      onChange={(event) => setNotes({ ...notes, [refund.id]: event.target.value })}
                    />
                    <button type="button" disabled={busy === `${refund.id}-APPROVE`} onClick={() => void act("APPROVE", refund)}>
                      <Money size={15}/>Retry Paystack
                    </button>
                    <button type="button" disabled={busy === `${refund.id}-RECORD`} onClick={() => void act("RECORD", refund)}>
                      <Wallet size={15}/>Record as paid
                    </button>
                  </> : <span className="console-note">Closed.</span>}
                </td>
              </tr>)}
            </tbody>
          </table>}
      <p className="console-note">
        Cancelling is free until a driver takes the seat, and a paid seat nobody takes is refunded automatically when the sweep window passes. This desk is for the refunds that need a person: a declined one, a manual transfer, or a send the rail refused.
      </p>
    </section>
  </section>;
}
