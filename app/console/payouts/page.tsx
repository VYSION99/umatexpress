"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Banknote, RefreshCw, Send, ShieldCheck, Undo2, Zap } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

type Totals = { accrued: number; ready: number; released: number; reversed: number; debt: number; balance: number; entries: number };
type Summary = {
  organizerId: string; name: string; organization: string; status: string; kycStatus: string;
  commissionBps: number; totals: Totals;
};
type Entry = {
  id: string; bookingReference: string; title: string; from: string; to: string;
  grossAmount: number; commissionAmount: number; netAmount: number; commissionBps: number;
  releaseAfter: string; status: string; transferReference: string; releasedAt: string;
  reversedAt: string; reversedReason: string; createdAt: string;
};
type Batch = {
  id: string; totalAmount: number; entryCount: number; transferReference: string; note: string;
  mode: string; status: string; transferCode: string; reason: string; attempts: number;
  initiatedAt: string; settledAt: string; createdAt: string;
};
type Automation = {
  enabled: boolean; provider: string; transferFee: number;
  balance: { currency: string; amount: number } | null;
};
type Detail = {
  organizer: {
    id: string; name: string; organization: string; status: string; kycStatus: string;
    commissionBps: number; payoutMethod: string; payoutAccountName: string; payoutAccountMasked: string;
    payoutBankName: string; recipientReady: boolean;
  };
  statement: { totals: Totals; entries: Entry[]; batches: Batch[] };
};

const cedis = (pesewas: number) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

export default function PayoutsConsolePage() {
  return <ConsoleSessionGate label="organizer payouts">
    {(session) => session.account.role === "ADMIN"
      ? <PayoutsWorkspace session={session} />
      : <ConsoleUnavailable session={session} service="payouts" label="ORGANIZER PAYOUTS" blurb="Recording payouts is an administrator action." />}
  </ConsoleSessionGate>;
}

function PayoutsWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const [organizers, setOrganizers] = useState<Summary[]>([]);
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState({ reference: "", note: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const loadOverview = useCallback(async () => {
    try {
      const response = await fetch("/api/console/payouts", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Organizer balances could not be loaded.");
      setOrganizers(data.organizers || []);
      setAutomation(data.automation || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Organizer balances could not be loaded.");
    }
  }, []);

  const loadDetail = useCallback(async (organizerId: string) => {
    try {
      const response = await fetch(`/api/console/payouts?organizerId=${encodeURIComponent(organizerId)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That statement could not be loaded.");
      setDetail(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "That statement could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(loadOverview); }, [loadOverview]);
  useEffect(() => { if (selected) queueMicrotask(() => loadDetail(selected)); }, [selected, loadDetail]);

  const record = useCallback(async () => {
    if (!detail) return;
    setBusy("record"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/payouts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizerId: detail.organizer.id, reference: form.reference, note: form.note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The payout could not be recorded.");
      setNotice(`Recorded ${cedis(data.batch.totalAmount)} across ${data.batch.entryCount} entries · ${data.batch.transferReference}`);
      setForm({ reference: "", note: "" });
      await Promise.all([loadDetail(detail.organizer.id), loadOverview()]);
    } catch (recordError) {
      setError(recordError instanceof Error ? recordError.message : "The payout could not be recorded.");
    } finally {
      setBusy("");
    }
  }, [detail, form, loadDetail, loadOverview]);

  const backfill = useCallback(async () => {
    setBusy("backfill"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/payouts/backfill", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Missing entries could not be rebuilt.");
      setNotice(`Checked ${data.scanned} confirmed bookings: ${data.accrued} entries rebuilt, ${data.skipped} already present${data.failed ? `, ${data.failed} failed` : ""}.`);
      await Promise.all([loadOverview(), detail ? loadDetail(detail.organizer.id) : Promise.resolve()]);
    } catch (backfillError) {
      setError(backfillError instanceof Error ? backfillError.message : "Missing entries could not be rebuilt.");
    } finally {
      setBusy("");
    }
  }, [detail, loadDetail, loadOverview]);

  const runAutomation = useCallback(async (action: "RELEASE" | "RECONCILE" | "RETRY", organizerId = "") => {
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/payouts/run", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, organizerId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That payout action could not run.");
      if (action === "RETRY") {
        setNotice(`${data.entries} parked ${data.entries === 1 ? "entry is" : "entries are"} eligible again. The next run will retry.`);
      } else if (action === "RECONCILE") {
        setNotice(`Checked ${data.result.scanned} in-flight transfers: ${data.result.settled} settled, ${data.result.failed} returned to the ledger.`);
      } else if (data.result.status === "SKIPPED") {
        setNotice(`Nothing was sent: ${data.result.reason}.`);
      } else {
        setNotice(`Considered ${data.result.considered} organizers: ${data.result.transferred} paid, ${data.result.inFlight} in flight, ${data.result.failed.length} failed, ${data.result.skipped.length} skipped.`);
      }
      await Promise.all([loadOverview(), detail ? loadDetail(detail.organizer.id) : Promise.resolve()]);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "That payout action could not run.");
    } finally {
      setBusy("");
    }
  }, [detail, loadDetail, loadOverview]);

  const totals = detail?.statement.totals;
  const ready = useMemo(() => (totals?.ready || 0) > 0 && (totals?.debt || 0) === 0, [totals]);
  const kycVerified = detail?.organizer.kycStatus === "VERIFIED";
  const failedEntries = useMemo(
    () => (detail?.statement.entries || []).filter((entry) => entry.status === "FAILED").length,
    [detail],
  );
  const automationReady = automation?.provider === "PAYSTACK";

  return <ConsoleShell
    session={session}
    service="payouts"
    label="ORGANIZER PAYOUTS"
    title="What the platform owes"
    blurb="Paystack sends what is due once the release date has passed and KYC is verified. You can also make a transfer yourself and record the reference here."
    actions={<button className="console-panel-close" disabled={busy === "backfill"} onClick={backfill}><RefreshCw size={14}/>{busy === "backfill" ? "Rebuilding…" : "Rebuild missing entries"}</button>}
  >

    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    <section className="console-panel">
      <h2><Zap size={18}/>Automatic payouts</h2>
      <div className="console-totals">
        <div>
          <span>Settled balance</span>
          <strong>{automation?.balance ? cedis(automation.balance.amount) : "unavailable"}</strong>
          <small>{automation?.balance?.currency || "—"} available to pay with</small>
        </div>
        <div>
          <span>Unattended runs</span>
          <strong>{automation?.enabled ? "On" : "Off"}</strong>
          <small>{automationReady ? "every 15 minutes" : "Paystack is not the payment provider"}</small>
        </div>
        <div>
          <span>Transfer fee budget</span>
          <strong>{cedis(automation?.transferFee || 0)}</strong>
          <small>reserved per transfer</small>
        </div>
      </div>
      <p className="console-note">
        Running this by hand sends real money now. It pays every organizer whose entries have cleared their release date, in the order they were earned,
        and stops when the settled balance runs out.
      </p>
      <div className="console-row-actions">
        <button disabled={busy === "RELEASE" || !automationReady} onClick={() => void runAutomation("RELEASE")}>
          <Send size={15}/>{busy === "RELEASE" ? "Sending…" : "Run payouts now"}
        </button>
        <button disabled={busy === "RECONCILE" || !automationReady} onClick={() => void runAutomation("RECONCILE")}>
          <RefreshCw size={15}/>{busy === "RECONCILE" ? "Checking…" : "Check in-flight transfers"}
        </button>
      </div>
      {!automation?.enabled && <p className="console-note">
        Unattended payouts are off, so the cron never sends. Set <code>PAYOUT_AUTO_ENABLED=true</code> as a Worker secret to turn them on.
      </p>}
    </section>

    <section className="console-panel">
      <h2><Banknote size={18}/>Balances by organizer</h2>
      {organizers.length === 0
        ? <p className="console-empty">No organizer has earned anything yet.</p>
        : <table className="console-table">
          <thead><tr><th>Organizer</th><th>KYC</th><th>Balance</th><th>Ready</th><th>Paid out</th><th></th></tr></thead>
          <tbody>
            {organizers.map((row) => (
              <tr key={row.organizerId}>
                <td><span>{row.organization || row.name}</span><small>{row.name}</small></td>
                <td><span className={`console-badge console-badge-${row.kycStatus.toLowerCase()}`}>{row.kycStatus}</span></td>
                <td><strong className={row.totals.balance < 0 ? "console-reason" : ""}>{cedis(row.totals.balance)}</strong></td>
                <td>{cedis(row.totals.ready)}</td>
                <td>{cedis(row.totals.released)}</td>
                <td className="console-row-actions">
                  <button onClick={() => { setSelected(row.organizerId); setError(""); setNotice(""); }}>Open statement</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

    {detail && <section className="console-panel">
      <h2><ShieldCheck size={18}/>{detail.organizer.organization || detail.organizer.name}
        <button className="console-panel-close" onClick={() => { setDetail(null); setSelected(""); }}>Close</button>
      </h2>
      <p className="console-note">
        {detail.organizer.payoutMethod || "No payout method"} · {detail.organizer.payoutBankName || "no bank or network"} · {detail.organizer.payoutAccountName || "no account name"} · {detail.organizer.payoutAccountMasked || "no account saved"} · commission {(detail.organizer.commissionBps / 100).toFixed(2)}%
      </p>
      {detail.organizer.payoutMethod && !detail.organizer.payoutBankName && <div className="console-alert" role="alert">
        <AlertTriangle size={15}/> This account was saved before banks and networks were recorded, so no transfer can be addressed to it. Ask the organizer to save their payout details again.
      </div>}
      {failedEntries > 0 && <div className="console-alert" role="alert">
        <AlertTriangle size={15}/> {failedEntries} {failedEntries === 1 ? "entry has" : "entries have"} stopped retrying after repeated failures.
        <button className="console-panel-close" disabled={busy === "RETRY"} onClick={() => void runAutomation("RETRY", detail.organizer.id)}>
          <RefreshCw size={14}/>{busy === "RETRY" ? "Reopening…" : "Retry these entries"}
        </button>
      </div>}

      {totals && totals.debt > 0 && <div className="console-alert" role="alert">
        <AlertTriangle size={15}/> {cedis(totals.debt)} was refunded after payout. The debt is carried forward; a batch is refused until it is settled.
      </div>}

      <form className="console-form" onSubmit={(event) => { event.preventDefault(); void record(); }}>
        <label>Transfer reference
          <input type="text" required value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} placeholder="Paystack or bank transfer reference" />
        </label>
        <label>Note (optional)
          <input type="text" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="August batch" />
        </label>
        <button disabled={busy === "record" || !ready || !kycVerified}>
          <Banknote size={16}/>{busy === "record" ? "Recording…" : `Record ${cedis(totals?.ready || 0)} payout`}
        </button>
      </form>
      {!kycVerified && <p className="console-note">KYC is {detail.organizer.kycStatus}. Verify it before recording a payout.</p>}
      {kycVerified && !ready && <p className="console-note">Nothing is ready to pay right now. Entries release after midnight following the trip, and a debt blocks the batch.</p>}

      <h3 className="console-note">Entries</h3>
      {detail.statement.entries.length === 0
        ? <p className="console-empty">No ledger entries.</p>
        : <table className="console-table">
          <thead><tr><th>Booking</th><th>Fare</th><th>Commission</th><th>Net</th><th>Release</th><th>Status</th></tr></thead>
          <tbody>
            {detail.statement.entries.map((entry) => (
              <tr key={entry.id}>
                <td><span>{entry.bookingReference || "—"}</span><small>{when(entry.createdAt)}</small></td>
                <td>{cedis(entry.grossAmount)}</td>
                <td>{cedis(entry.commissionAmount)}</td>
                <td><strong>{cedis(entry.netAmount)}</strong></td>
                <td>{when(entry.releaseAfter)}</td>
                <td>
                  <span className={`console-badge console-badge-${entry.status.toLowerCase()}`}>{entry.status}</span>
                  {entry.transferReference && <small>Ref {entry.transferReference}</small>}
                  {entry.reversedReason && <small className="console-reason">{entry.reversedReason}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}

      <h3 className="console-note">Payout batches</h3>
      {detail.statement.batches.length === 0
        ? <p className="console-empty">No payout has been recorded for this organizer.</p>
        : <table className="console-table">
          <thead><tr><th>Date</th><th>Reference</th><th>Entries</th><th>Amount</th><th>Recorded by</th></tr></thead>
          <tbody>
            {detail.statement.batches.map((batch) => (
              <tr key={batch.id}>
                <td>{when(batch.createdAt)}</td>
                <td><span>{batch.transferReference || "—"}</span><small>{batch.mode}{batch.transferCode ? ` · ${batch.transferCode}` : ""}</small></td>
                <td>{batch.entryCount}</td>
                <td><strong>{cedis(batch.totalAmount)}</strong></td>
                <td>
                  <span className={`console-badge console-badge-${batch.status === "SUCCESS" ? "released" : batch.status === "FAILED" ? "failed" : "accrued"}`}>{batch.status}</span>
                  <small>{batch.reason || batch.note || "—"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
      <p className="console-note"><Undo2 size={13}/> A cancelled booking reverses its entry. If it had already been paid out, the reversal becomes a debt on the next batch.</p>
    </section>}
  </ConsoleShell>;
}
