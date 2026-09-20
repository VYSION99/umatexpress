"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, CheckCircle2, Loader2, RotateCcw, Search, Undo2, Wallet } from "lucide-react";
import { cedis } from "@/components/campusRide/hostel/format";

type Refund = {
  id: string; bookingId: string; reference: string; landlordId: string; studentEmail: string;
  amount: number; commissionAmount: number; netAmount: number; policy: string; percent: number;
  overrideReason: string; reason: string; status: string; decidedBy: string; decidedAt: string;
  paystackReference: string; providerStatus: string; settledAt: string; createdAt: string;
};
type Summary = { total: number; requested: number; approved: number; paid: number; declined: number; failed: number; paidAmount: number };

const FILTERS = ["ALL", "REQUESTED", "APPROVED", "PAID", "DECLINED", "FAILED"] as const;
const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const badge = (status: string) => status === "PAID" ? "approved" : status === "DECLINED" || status === "FAILED" ? "rejected" : "pending";

/**
 * The refund queue. A student's cancellation arrives as a request priced by
 * the policy; an administrator approves it (or overrides with a stated
 * reason), declines it with a reason, or records the transfer by hand when the
 * money moved outside Paystack. Paystack settles in its own time, so an
 * approved row can also be checked with "Ask Paystack".
 */
export function HostelRefundsPanel() {
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("REQUESTED");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const query = filter === "ALL" ? "" : `?status=${filter}`;
      const response = await fetch(`/api/console/hostel/refunds${query}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { refunds?: Refund[]; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error || "The refunds could not be loaded.");
      setRefunds(data.refunds || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The refunds could not be loaded.");
    }
  }, [filter]);

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

  async function act(refund: Refund, action: "APPROVE" | "DECLINE" | "RECORD") {
    await run(async () => {
      setBusy(refund.id);
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/refunds", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            refundId: refund.id,
            reason: reasons[refund.id] || "",
            overridePercent: (overrides[refund.id] || "").trim(),
            reference: references[refund.id] || "",
            note: reasons[refund.id] || "",
          }),
        });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error || "That decision was not saved.");
        setNotice(action === "APPROVE" ? "Refund approved; Paystack has the transfer." : action === "DECLINE" ? "Refund declined and the student told why." : "Refund recorded as paid.");
        setReasons((current) => ({ ...current, [refund.id]: "" }));
        setReferences((current) => ({ ...current, [refund.id]: "" }));
        setOverrides((current) => ({ ...current, [refund.id]: "" }));
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  async function reconcile() {
    await run(async () => {
      setBusy("reconcile");
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/refunds", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "RECONCILE" }),
        });
        const data = await response.json() as { result?: { scanned: number; settled: number; stillPending: number }; error?: string };
        if (!response.ok) throw new Error(data.error || "The reconcile did not finish.");
        setNotice(data.result ? `Asked Paystack about ${data.result.scanned} refunds: ${data.result.settled} settled, ${data.result.stillPending} still processing.` : "Reconcile finished.");
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  if (!refunds) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Opening the refund queue…</p>;

  const overrideValue = (refund: Refund) => (overrides[refund.id] || "").trim();

  return <section className="console-panel">
    <h2><RotateCcw size={18} aria-hidden />Refund queue
      {summary && summary.requested > 0 && <span className="console-badge console-badge-pending">{summary.requested} waiting</span>}
      <button type="button" className="console-panel-close" onClick={() => void reconcile()} disabled={busy === "reconcile"}>
        {busy === "reconcile" ? <Loader2 size={14} className="console-spin" aria-hidden /> : <Search size={14} aria-hidden />} Ask Paystack
      </button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    {summary && <p className="console-note">
      {summary.requested} to decide · {summary.approved} with Paystack · {summary.paid} paid ({cedis(summary.paidAmount)}) · {summary.declined} declined · {summary.failed} failed.
      {" "}Approving frees the bed and reverses the landlord&apos;s accrual, so a refunded bed is never paid out.
    </p>}
    <div className="console-toolbar">
      {FILTERS.map((option) => <button key={option} type="button" className={filter === option ? "is-active" : ""} onClick={() => setFilter(option)}>
        {option === "ALL" ? "All" : option[0] + option.slice(1).toLowerCase()}
      </button>)}
    </div>
    {refunds.length === 0
      ? <p className="console-empty">Nothing under this filter.</p>
      : <ul className="console-reviews">
        {refunds.map((refund) => <li key={refund.id}>
          <header>
            <span className={`console-badge console-badge-${badge(refund.status)}`}><Undo2 size={11} aria-hidden />{refund.status}</span>
            <strong>{refund.studentEmail || "Student"} · {cedis(refund.amount)}</strong>
            <small>{refund.reference} · asked {when(refund.createdAt)}</small>
          </header>
          <p>
            {refund.policy === "OVERRIDE"
              ? `Override at ${refund.percent}%${refund.overrideReason ? ` — ${refund.overrideReason}` : ""}`
              : `Policy ${refund.policy} · ${refund.percent}% · ${cedis(refund.amount)} of the year`}
            {refund.reason ? ` · Student said: ${refund.reason}` : ""}
          </p>
          {refund.paystackReference && <p className="console-note">Paystack {refund.paystackReference} · {refund.providerStatus || "pending"}{refund.settledAt ? ` · settled ${when(refund.settledAt)}` : ""}</p>}
          {refund.status === "REQUESTED" && <>
            <div className="console-row-actions">
              <input
                type="text"
                value={reasons[refund.id] || ""}
                onChange={(event) => setReasons((current) => ({ ...current, [refund.id]: event.target.value }))}
                placeholder="Reason (required to decline or override)"
                maxLength={300}
              />
              <input
                type="number"
                value={overrides[refund.id] || ""}
                onChange={(event) => setOverrides((current) => ({ ...current, [refund.id]: event.target.value }))}
                placeholder={`Override % (blank = ${refund.percent}%)`}
                min={0}
                max={100}
                style={{ maxWidth: "190px" }}
              />
            </div>
            <div className="console-row-actions">
              <button type="button" className="console-primary" disabled={busy === refund.id} onClick={() => void act(refund, "APPROVE")}>
                {busy === refund.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
                {overrideValue(refund) ? `Approve at ${overrideValue(refund)}%` : `Approve ${cedis(refund.amount)}`}
              </button>
              <button type="button" className="console-secondary" disabled={busy === refund.id || !(reasons[refund.id] || "").trim()} onClick={() => void act(refund, "DECLINE")}>
                <Ban size={14} aria-hidden /> Decline with reason
              </button>
            </div>
          </>}
          {(refund.status === "APPROVED" || refund.status === "FAILED") && <>
            <div className="console-row-actions">
              <input
                type="text"
                value={references[refund.id] || ""}
                onChange={(event) => setReferences((current) => ({ ...current, [refund.id]: event.target.value }))}
                placeholder="Transfer reference"
                maxLength={80}
              />
              <button type="button" className="console-secondary" disabled={busy === refund.id || (references[refund.id] || "").trim().length < 3} onClick={() => void act(refund, "RECORD")}>
                <Wallet size={14} aria-hidden /> Record as paid
              </button>
            </div>
            <p className="console-note">Record this only when the money moved outside Paystack; the reference is what closes the booking.</p>
          </>}
          {(refund.status === "PAID" || refund.status === "DECLINED") && <p className="console-note">
            {refund.decidedBy ? `${refund.status === "PAID" ? "Settled" : "Decided"} by ${refund.decidedBy} · ${when(refund.settledAt || refund.decidedAt)}` : "Closed."}
            {refund.providerStatus && refund.status === "DECLINED" ? ` · ${refund.providerStatus}` : ""}
          </p>}
        </li>)}
      </ul>}
  </section>;
}
