"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle, Money } from "@/components/ui/MaterialIcon";

type Row = Record<string, unknown>;
type Data = { paymentsEnabled: boolean; profiles: Row[]; payments: Row[]; refunds: Row[]; settlements: Row[] };
const cash = (value: unknown) => new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS" }).format(Number(value || 0) / 100);

export function FoodFinanceManager() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const response = await fetch("/api/console/food/payments", { cache: "no-store" });
    const value = await response.json() as Data & { error?: string };
    if (!response.ok) throw new Error(value.error || "Food finance could not be loaded.");
    setData(value);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load().catch((problem) => setError(problem instanceof Error ? problem.message : "Food finance could not be loaded.")), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(body: Record<string, unknown>, key: string) {
    setBusy(key); setError("");
    try {
      const response = await fetch("/api/console/food/payments", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || "Finance action failed.");
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Finance action failed.");
    } finally { setBusy(""); }
  }

  if (!data) return <section className="console-card"><p>{error || "Loading Food finance…"}</p></section>;
  const refundAttention = data.refunds.filter((row) => ["REQUESTED", "FAILED", "REVIEW"].includes(String(row.status)));
  const available = data.settlements.filter((row) => String(row.status) === "AVAILABLE");

  return <div className="food-finance">
    {error && <p className="console-alert" role="alert">{error}</p>}
    <section className="console-card food-launch-gate">
      <Money size={24} /><div><h2>Online payment gate</h2><p>Both this global gate and a provider profile must be enabled. Pausing it stops new checkout and preserves money already in progress.</p></div>
      <button disabled={busy === "global"} onClick={() => void act({ action: "GLOBAL", enabled: !data.paymentsEnabled }, "global")}>{data.paymentsEnabled ? "Pause online payments" : "Enable online payments"}</button>
    </section>
    <section className="console-card">
      <div className="food-section-heading"><div><h2>Provider money rules</h2><p>Commission is frozen at checkout. Earnings start their release delay only after collection.</p></div></div>
      <div className="food-settings-grid">{data.profiles.map((row) => <form key={String(row.id)} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void act({ action: "PROFILE", providerId: row.id, enabled: form.get("enabled") === "on", commissionBps: Number(form.get("commissionBps")), settlementDelayMinutes: Number(form.get("settlementDelayMinutes")) }, `profile-${row.id}`); }}>
        <header><div><h3>{String(row.name)}</h3><p>{Number(row.enabled || 0) === 1 ? "Checkout enrolled" : "Checkout disabled"}</p></div><label className="food-switch"><input name="enabled" type="checkbox" defaultChecked={Number(row.enabled || 0) === 1} /><span>Enabled</span></label></header>
        <label>Commission (basis points)<input name="commissionBps" type="number" min="0" max="5000" defaultValue={Number(row.commission_bps || 1000)} /></label>
        <label>Release delay (minutes)<input name="settlementDelayMinutes" type="number" min="0" max="43200" defaultValue={Number(row.settlement_delay_minutes || 1440)} /></label>
        <button disabled={busy === `profile-${row.id}`}>Save money rules</button>
      </form>)}</div>
    </section>
    <section className="console-card">
      <h2>Refund attention <span>{refundAttention.length}</span></h2><p>A requested refund may be approved once. Failed or review records must be reconciled before any further provider action.</p>
      {refundAttention.length === 0 ? <p>No refund needs attention.</p> : <div className="food-support-list">{refundAttention.map((row) => {
        const status = String(row.status); const key = `refund-${row.id}`;
        return <article key={String(row.id)}><div><span className={`food-status is-${status.toLowerCase()}`}>{status}</span><h3>{String(row.order_reference)} · {String(row.provider_name)}</h3><p>{cash(row.amount)} · {String(row.cause)}</p><small>{String(row.reason)}</small></div>
          {status === "REQUESTED" ? <><label>Approval note<input value={notes[String(row.id)] || ""} onChange={(event) => setNotes({ ...notes, [String(row.id)]: event.target.value })} /></label><button disabled={busy === key || (notes[String(row.id)] || "").trim().length < 8} onClick={() => void act({ action: "REFUND", id: row.id, note: notes[String(row.id)] }, key)}>Approve refund</button></> : <p className="console-alert">Reconcile this provider result in Payment operations. Do not send another refund.</p>}
        </article>;
      })}</div>}
    </section>
    <section className="console-card">
      <h2>Vendor settlement <span>{available.length}</span></h2><p>Record a payout only after sending this exact earning outside the platform. Keep the transfer reference for reconciliation.</p>
      {available.length === 0 ? <p>No vendor earnings are available.</p> : <div className="food-support-list">{available.map((row) => <article key={String(row.id)}><div><h3>{String(row.provider_name)} · {String(row.order_reference)}</h3><p>Vendor net {cash(row.net_amount)} · commission {cash(row.commission_amount)}</p></div><label>Payout reference<input value={notes[String(row.id)] || ""} onChange={(event) => setNotes({ ...notes, [String(row.id)]: event.target.value })} /></label><button disabled={busy === `settle-${row.id}` || (notes[String(row.id)] || "").trim().length < 4} onClick={() => void act({ action: "SETTLEMENT", id: row.id, reference: notes[String(row.id)] }, `settle-${row.id}`)}><CheckCircle size={15} />Record paid</button></article>)}</div>}
    </section>
    <details className="console-card"><summary>Recent payment records <span>{data.payments.length}</span></summary>{data.payments.map((row) => {
      const failureKey = `failure-${row.id}`;
      return <div key={String(row.id)} className="food-payment-row"><p><strong>{String(row.order_reference)}</strong> · {String(row.status)} · {cash(row.amount)}</p>{String(row.status) === "SUCCESSFUL" && ["ACCEPTED", "READY"].includes(String(row.order_status)) && !row.refund_status && <><input aria-label={`Failure reason for ${String(row.order_reference)}`} placeholder="Provider failure reason" value={notes[failureKey] || ""} onChange={(event) => setNotes({ ...notes, [failureKey]: event.target.value })} /><button disabled={(notes[failureKey] || "").trim().length < 8 || busy === failureKey} onClick={() => void act({ action: "OPEN_REFUND", preorderId: row.preorder_id, note: notes[failureKey] }, failureKey)}>Cancel and open refund</button></>}</div>;
    })}</details>
  </div>;
}
