"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgeCheck, Banknote, RefreshCw, Send, ShieldCheck, Undo2, UserX, Zap } from "lucide-react";
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
  id: string; totalAmount: number; transferFee: number; entryCount: number; transferReference: string; note: string;
  mode: string; status: string; transferCode: string; reason: string; attempts: number;
  awaitingOtp: boolean;
  initiatedAt: string; settledAt: string; createdAt: string;
};
type Automation = {
  enabled: boolean; provider: string; transferFee: { momo: number; bank: number }; minimum: number; feePercent: number;
  releaseMinutes: number;
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
/** The release gate is minutes now, so a date alone would hide the hour that matters. */
const whenDue = (iso: string) => (iso
  ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  : "—");

/**
 * Why the release job left an organizer alone, in words rather than a code.
 * The job reports the reason; the console owes the reader the sentence, and
 * the ones worth acting on say what would have to change.
 */
const SKIP_REASONS: Record<string, string> = {
  BELOW_MINIMUM: "below the minimum payout",
  BELOW_FEE: "the payout would not survive its own transfer fee",
  INSUFFICIENT_BALANCE: "the settled balance cannot cover them",
  BALANCE_UNAVAILABLE: "the Paystack balance could not be read",
  NOT_APPROVED: "the organizer is not approved",
  KYC_NOT_VERIFIED: "KYC is not verified",
  NO_DESTINATION: "no payout destination is saved",
  UNSUPPORTED_DESTINATION: "the saved account is a bank, and rides pay out to mobile money",
  NOTHING_DUE: "nothing is owed",
  TOO_MANY_ENTRIES: "more entries than one batch should carry",
  CLAIMED_BY_ANOTHER_RUN: "another run claimed them first",
  NO_ORGANIZER: "the entry has no organizer",
};

/** "2 the settled balance cannot cover them, 1 below the minimum payout". */
function skipBreakdown(skipped: Array<{ reason: string }>) {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${count} ${SKIP_REASONS[reason] || reason.toLowerCase()}`)
    .join(", ");
}

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
  const [otp, setOtp] = useState<Record<string, string>>({});
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

  /**
   * KYC is the money gate. The decision belongs to the organizers service, but
   * the administrator meets it here as a blocked payout, so the action is put
   * where the blocker is instead of sending them to another page to find it.
   */
  const decideKyc = useCallback(async (organizerId: string, action: "VERIFY_KYC" | "REJECT_KYC") => {
    let reason = "";
    if (action === "REJECT_KYC") {
      reason = window.prompt("Why is this KYC rejected?")?.trim() || "";
      if (!reason) return;
    }
    setBusy(`kyc-${organizerId}`); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/organizers", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizerId, action, reason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The KYC decision could not be saved.");
      setNotice(`${data.organizer?.organization || data.organizer?.name || "Organizer"} · KYC ${data.organizer?.kycStatus || "updated"}`);
      await Promise.all([
        loadOverview(),
        detail?.organizer.id === organizerId ? loadDetail(organizerId) : Promise.resolve(),
      ]);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The KYC decision could not be saved.");
    } finally {
      setBusy("");
    }
  }, [detail, loadDetail, loadOverview]);

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
        const skipped = skipBreakdown(data.result.skipped || []);
        setNotice(
          `Considered ${data.result.considered} organizers: ${data.result.transferred} paid, ${data.result.inFlight} in flight, ${data.result.failed.length} failed, ${data.result.skipped.length} skipped${skipped ? ` (${skipped})` : ""}.`,
        );
      }
      await Promise.all([loadOverview(), detail ? loadDetail(detail.organizer.id) : Promise.resolve()]);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "That payout action could not run.");
    } finally {
      setBusy("");
    }
  }, [detail, loadDetail, loadOverview]);

  /**
   * Hands Paystack the code it asked for. The code lives in component state
   * only: it is sent once, cleared the moment the request returns, and never
   * kept in the browser or the ledger.
   */
  const authoriseTransfer = useCallback(async (batchId: string) => {
    const code = String(otp[batchId] || "").trim();
    if (!code) { setError("Enter the one-time password Paystack sent you."); return; }
    setBusy(`otp-${batchId}`); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/payouts/run", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "FINALIZE", batchId, otp: code }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That transfer could not be authorised.");
      setOtp((current) => ({ ...current, [batchId]: "" }));
      const result = data.result || {};
      setNotice(result.status === "RELEASED"
        ? "Paystack accepted the code and released the transfer."
        : result.status === "FAILED"
          ? `Paystack refused the transfer: ${result.reason || "unknown reason"}. The entries went back to the ledger.`
          : result.awaitingOtp
            ? "Paystack is still waiting for a code. Check the one it sent and try again."
            : "The code was accepted. The transfer is on its way and will settle itself.");
      await Promise.all([loadOverview(), detail ? loadDetail(detail.organizer.id) : Promise.resolve()]);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "That transfer could not be authorised.");
    } finally {
      setBusy("");
    }
  }, [detail, loadDetail, loadOverview, otp]);

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
          <small>{automationReady ? "on nearly every minute of the hour" : "Paystack is not the payment provider"}</small>
        </div>
        <div>
          <span>Transfer fee</span>
          <strong>{cedis(automation?.transferFee?.momo || 0)}</strong>
          <small>deducted from the payout · {cedis(automation?.transferFee?.bank || 0)} to a bank</small>
        </div>
        <div>
          <span>Minimum payout</span>
          <strong>{cedis(automation?.minimum || 0)}</strong>
          <small>a smaller balance waits for the next batch</small>
        </div>
      </div>
      <p className="console-note">
        Running this by hand sends real money now. It pays every organizer whose entries have cleared their release date, in the order they were earned,
        and stops when the settled balance runs out. Paystack takes {automation?.feePercent ?? 0}% at checkout, which the passenger pays on top of the fare,
        and {cedis(automation?.transferFee?.momo || 0)} per mobile money transfer, which is deducted from the payout itself — the organizer receives their
        balance less that fee, and nothing is charged to the platform. Rides pay out to mobile money only; organizers are told this where they save the account.
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
        Unattended payouts are off, so the cron never sends. Turn them on in <a href="/console/settings">Platform settings</a>, where the payout fee and
        minimum live too.
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
                  {row.kycStatus !== "VERIFIED" && <button disabled={busy === `kyc-${row.organizerId}`} onClick={() => void decideKyc(row.organizerId, "VERIFY_KYC")}>
                    <BadgeCheck size={15}/>Verify KYC
                  </button>}
                  {row.kycStatus === "PENDING" && <button disabled={busy === `kyc-${row.organizerId}`} onClick={() => void decideKyc(row.organizerId, "REJECT_KYC")}>
                    <UserX size={15}/>Reject KYC
                  </button>}
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
      {!kycVerified && <div className="console-row-actions">
        <span className="console-note">KYC is {detail.organizer.kycStatus}. Verify it before recording a payout.</span>
        <button disabled={busy === `kyc-${detail.organizer.id}`} onClick={() => void decideKyc(detail.organizer.id, "VERIFY_KYC")}>
          <BadgeCheck size={15}/>{busy === `kyc-${detail.organizer.id}` ? "Saving…" : "Verify KYC"}
        </button>
        {detail.organizer.kycStatus === "PENDING" && <button disabled={busy === `kyc-${detail.organizer.id}`} onClick={() => void decideKyc(detail.organizer.id, "REJECT_KYC")}>
          <UserX size={15}/>Reject KYC
        </button>}
      </div>}
      {kycVerified && !ready && <p className="console-note">
        Nothing is ready to pay right now. An entry becomes ready{" "}
        {automation?.releaseMinutes === 0 ? "as soon as the booking is paid" : `${automation?.releaseMinutes ?? 20} minutes after the booking was paid`}, and a
        debt blocks the batch.
      </p>}

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
                <td>{whenDue(entry.releaseAfter)}</td>
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
          <thead><tr><th>Date</th><th>Reference</th><th>Entries</th><th>Amount</th><th>Received</th><th>Recorded by</th></tr></thead>
          <tbody>
            {detail.statement.batches.map((batch) => (
              <tr key={batch.id}>
                <td>{when(batch.createdAt)}</td>
                <td><span>{batch.transferReference || "—"}</span><small>{batch.mode}{batch.transferCode ? ` · ${batch.transferCode}` : ""}</small></td>
                <td>{batch.entryCount}</td>
                <td><strong>{cedis(batch.totalAmount)}</strong></td>
                <td>
                  <strong>{cedis(batch.totalAmount - batch.transferFee)}</strong>
                  {batch.transferFee > 0 && <small>after {cedis(batch.transferFee)} transfer fee</small>}
                </td>
                <td>
                  <span className={`console-badge console-badge-${batch.status === "SUCCESS" ? "released" : batch.status === "FAILED" ? "failed" : "accrued"}`}>{batch.status}</span>
                  <small>{batch.awaitingOtp ? "Waiting for the one-time password Paystack sent you." : batch.reason || batch.note || "—"}</small>
                  {batch.awaitingOtp && <form
                    className="console-otp"
                    onSubmit={(event) => { event.preventDefault(); void authoriseTransfer(batch.id); }}
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      aria-label="Paystack one-time password"
                      placeholder="Paystack OTP"
                      value={otp[batch.id] || ""}
                      onChange={(event) => setOtp((current) => ({ ...current, [batch.id]: event.target.value }))}
                    />
                    <button disabled={busy === `otp-${batch.id}`}>
                      {busy === `otp-${batch.id}` ? "Authorising…" : "Authorise"}
                    </button>
                  </form>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
      <p className="console-note"><Undo2 size={13}/> A cancelled booking reverses its entry. If it had already been paid out, the reversal becomes a debt on the next batch.</p>
    </section>}
  </ConsoleShell>;
}
