"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgeCheck, Banknote, Eye, RefreshCw, Send, Settings, ShieldCheck, Undo2, UserX, Wrench, Zap } from "lucide-react";
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
type PreviewRow = {
  organizerId: string; name: string; organization: string;
  amount: number; entryCount: number; oldest: string;
  fee: number; receives: number;
  status: "PAYABLE" | "UNFUNDED" | "BLOCKED"; reason: string;
};
type Preview = {
  status: "OK" | "SKIPPED"; reason?: string;
  provider: string; autoEnabled: boolean; balance: number | null;
  minimum: number; releaseMinutes: number; perRunLimit: number; attendedLimit: number;
  dueTotal: number; payableTotal: number; sendableTotal: number;
  candidates: PreviewRow[];
  deferred: Array<{ organizerId: string; name: string; organization: string; amount: number; entryCount: number; reason: string }>;
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

/**
 * Why an organizer is held out of the run entirely, which is a different
 * question from why a payout is refused: these two are decided before the run
 * looks at anyone, and a support answer needs both.
 */
const DEFERRED_REASONS: Record<string, string> = {
  DEBT_STANDING: "a reversal left a debt, and a debt blocks the next batch",
  TRANSFER_IN_FLIGHT: "a transfer for them is already with Paystack",
};

const VERDICT_TONE: Record<string, string> = {
  PAYABLE: "console-badge-available",
  UNFUNDED: "console-badge-requested",
  BLOCKED: "console-badge-rejected",
};
const VERDICT_LABEL: Record<string, string> = {
  PAYABLE: "Ready",
  UNFUNDED: "Waiting on balance",
  BLOCKED: "Blocked",
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState({ reference: "", note: "" });
  const [otp, setOtp] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState("");
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
      setPreview(data.preview || null);
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

  const reveal = useCallback(async () => {
    if (!detail) return;
    setBusy("reveal"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/organizers/reveal", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizerId: detail.organizer.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The account could not be revealed.");
      setRevealed(String(data.revealed?.payoutAccountNumber || ""));
      setNotice("Payout account revealed. This read is written to the audit log.");
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : "The account could not be revealed.");
    } finally {
      setBusy("");
    }
  }, [detail]);

  const copy = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setError("The browser would not copy that value.");
    }
  }, []);

  /**
   * The unattended switch, in the place the money is. Turning it off keeps the
   * ledger and the statements and stops every scheduled transfer, which is the
   * safe state while a destination is being fixed.
   */
  const setAuto = useCallback(async (enabled: boolean) => {
    setBusy("auto"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "organizer_payout_auto", enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The unattended switch could not be saved.");
      setNotice(`Unattended payouts ${enabled ? "on" : "off"} — recorded against ${session.account.email}.`);
      await loadOverview();
    } catch (autoError) {
      setError(autoError instanceof Error ? autoError.message : "The unattended switch could not be saved.");
    } finally {
      setBusy("");
    }
  }, [loadOverview, session.account.email]);

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
   * Authorises a transfer Paystack held for a one-time password. The code is
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

  /** Platform-wide figures, so the strip above can say what is payable and why not. */
  const book = useMemo(() => {
    const owed = organizers.reduce((total, row) => total + row.totals.balance, 0);
    const readyTotal = organizers.reduce((total, row) => total + Math.max(0, row.totals.ready), 0);
    const paidOut = organizers.reduce((total, row) => total + row.totals.released, 0);
    const cash = automation?.balance ? automation.balance.amount : null;
    return { owed, readyTotal, paidOut, cash };
  }, [organizers, automation]);

  /**
   * The next run in one sentence, built from the same forecast the table below
   * shows. The point of the panel is that a support question — "why has this
   * organizer not been paid?" — is answered here, before anyone presses send.
   */
  const plan = useMemo(() => {
    if (!preview) return { tone: "", text: "Reading the ledger and the payment rails…" };
    if (preview.status === "SKIPPED") {
      return { tone: "is-warning", text: preview.reason === "TURSO_NOT_CONFIGURED"
        ? "The ledger cannot be read, so no run can be planned."
        : "Payments are not running through Paystack, so nothing can be sent." };
    }
    const payable = preview.candidates.filter((row) => row.status === "PAYABLE");
    const unfunded = preview.candidates.filter((row) => row.status === "UNFUNDED");
    const blocked = preview.candidates.filter((row) => row.status === "BLOCKED");
    const waiting = unfunded.length > 0;
    // A run stops at perRunLimit, so the headline counts the organizers that run
    // would actually reach rather than everything that is payable.
    const thisRun = payable.slice(0, preview.perRunLimit);
    const thisRunTotal = thisRun.reduce((total, row) => total + row.amount, 0);
    const beyondCap = preview.sendableTotal - thisRunTotal;
    const cap = beyondCap > 0
      ? ` The schedule addresses ${preview.perRunLimit} at a time and this button up to ${preview.attendedLimit}, so ${cedis(beyondCap)} waits for the following run.`
      : "";
    if (preview.dueTotal === 0) {
      return { tone: "", text: "Nothing is due right now. An entry becomes payable once its release window has passed." };
    }
    if (payable.length === 0 && waiting) {
      return { tone: "is-warning", text: `Nothing can be sent: ${cedis(preview.dueTotal)} is due and the settled Paystack balance covers none of it. Money that settles straight to your bank leaves no balance to transfer from — keep funds in Paystack or top the balance up.` };
    }
    if (payable.length === 0) {
      return { tone: "is-warning", text: `${cedis(preview.dueTotal)} is due, and every organizer behind it is blocked — ${blocked.length} in all. The reasons are beside each name below.` };
    }
    const sent = `The next run would send ${cedis(thisRunTotal)} to ${thisRun.length} ${thisRun.length === 1 ? "organizer" : "organizers"}.`;
    const rest = waiting
      ? ` ${cedis(preview.dueTotal - preview.sendableTotal)} more is due and waits for the settled balance to cover it.`
      : blocked.length
        ? ` ${blocked.length} ${blocked.length === 1 ? "organizer is" : "organizers are"} blocked for another reason.`
        : beyondCap > 0 ? "" : " Everything due is covered.";
    return { tone: waiting || blocked.length ? "is-warning" : "", text: `${sent}${rest}${cap}` };
  }, [preview]);

  return <ConsoleShell
    session={session}
    service="payouts"
    label="ORGANIZER PAYOUTS"
    title="Organizer payouts"
    blurb="Paystack sends what is due once the release window has passed and KYC is verified. You can also transfer by hand and record the reference."
    actions={<Link className="console-panel-close" href="/console/settings"><Settings size={14}/>Payout settings</Link>}
  >

    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    <section className="console-panel">
      <h2><Zap size={18}/>Payment rails</h2>
      <div className="console-stat-grid">
        <article>
          <span>Settled balance</span>
          <strong>{automation?.balance ? cedis(automation.balance.amount) : "unavailable"}</strong>
          <small>{automation?.balance?.currency || "—"} available in Paystack to pay with</small>
        </article>
        <article>
          <span>Due now</span>
          <strong>{cedis(book.readyTotal)}</strong>
          <small>{cedis(book.owed)} owed in total · {cedis(book.paidOut)} paid out to date</small>
        </article>
        <article>
          <span>Unattended runs</span>
          <strong>{automation?.enabled ? "On" : "Off"}</strong>
          <small>{automationReady ? "the job runs on nearly every minute of the hour" : "Paystack is not the payment provider"}</small>
        </article>
        <article>
          <span>Transfer fee</span>
          <strong>{cedis(automation?.transferFee?.momo || 0)}</strong>
          <small>{cedis(automation?.transferFee?.bank || 0)} to a bank · taken off the payout</small>
        </article>
        <article>
          <span>Minimum payout</span>
          <strong>{cedis(automation?.minimum || 0)}</strong>
          <small>a smaller balance waits for the next batch</small>
        </article>
        <article>
          <span>Release window</span>
          <strong>{automation?.releaseMinutes === 0 ? "Instant" : `${automation?.releaseMinutes ?? 20} min`}</strong>
          <small>after the booking was paid, before it is payable</small>
        </article>
      </div>

      <details className="console-disclosure">
        <summary>How a payout is worked out</summary>
        <p>
          Paystack takes {automation?.feePercent ?? 0}% at checkout, which the passenger pays on top of the fare, and
          {" "}{cedis(automation?.transferFee?.momo || 0)} per mobile money transfer, which is deducted from the payout itself — the organization
          receives its balance less that fee and nothing is charged to the platform. Rides pay out to mobile money only. A run
          pays every organizer whose entries have cleared their release window, oldest first, and stops when the settled balance runs out.
        </p>
      </details>
    </section>

    <section className="console-panel">
      <h2><Settings size={18}/>Payout actions</h2>

      <h3 className="console-subhead">Send</h3>
      <div className="console-actions">
        <button className="console-action is-primary" disabled={busy === "RELEASE" || !automationReady} onClick={() => void runAutomation("RELEASE")}>
          <strong><Send size={15}/>{busy === "RELEASE" ? "Sending…" : "Run payouts now"}</strong>
          <small>Pays every due balance through Paystack, oldest earnings first, until the settled balance runs out.</small>
        </button>
        <button className="console-action" disabled={busy === "RECONCILE" || !automationReady} onClick={() => void runAutomation("RECONCILE")}>
          <strong><RefreshCw size={15}/>{busy === "RECONCILE" ? "Checking…" : "Check in-flight transfers"}</strong>
          <small>Asks Paystack about transfers already sent that have not settled. The webhook is the fast path.</small>
        </button>
      </div>

      <h3 className="console-subhead">Repair</h3>
      <div className="console-actions">
        <button className="console-action" disabled={busy === "backfill"} onClick={backfill}>
          <strong><Wrench size={15}/>{busy === "backfill" ? "Rebuilding…" : "Rebuild missing entries"}</strong>
          <small>Rebuilds ledger rows for confirmed bookings whose accrual failed. Safe: it never duplicates a row.</small>
        </button>
        <button className="console-action" disabled={busy === "RETRY" || !detail || failedEntries === 0} onClick={() => detail && void runAutomation("RETRY", detail.organizer.id)}>
          <strong><Undo2 size={15}/>{busy === "RETRY" ? "Reopening…" : "Retry parked entries"}</strong>
          <small>{detail ? `${failedEntries} stopped after repeated failures for ${detail.organizer.name}.` : "Open an organizer's statement, then reopen entries that stopped after failures."}</small>
        </button>
      </div>

      <h3 className="console-subhead">Control</h3>
      <div className="console-actions">
        <button className="console-action" disabled={busy === "auto"} onClick={() => void setAuto(!automation?.enabled)}>
          <strong><Zap size={15}/>{busy === "auto" ? "Saving…" : automation?.enabled ? "Turn unattended payouts off" : "Turn unattended payouts on"}</strong>
          <small>{automation?.enabled ? "The scheduled job stops sending; the ledger and the statements keep working." : "Lets the scheduled job send what is due without anyone pressing a button."}</small>
        </button>
        <button className="console-action" disabled={busy === "refresh"} onClick={() => { setBusy("refresh"); void loadOverview().finally(() => setBusy("")); }}>
          <strong><RefreshCw size={15}/>{busy === "refresh" ? "Refreshing…" : "Refresh balances"}</strong>
          <small>Reads the ledger and the Paystack balance again. Sends nothing.</small>
        </button>
        <Link className="console-action" href="/console/settings">
          <strong><Settings size={15}/>Payout settings</strong>
          <small>Release window, minimum payout and transfer fees, with an audit of every change.</small>
        </Link>
      </div>
    </section>

    <section className="console-panel">
      <h2><Eye size={18}/>What the next run would do</h2>
      <p className="console-note">Built by reading the ledger and the payment rails. It sends nothing: no recipient, no batch, no transfer is created by looking.</p>

      {plan && <div className={`console-strip ${plan.tone}`} role="status">
        <Zap size={16}/>
        <span>{plan.text}</span>
      </div>}

      {preview?.status === "OK" && <>
        <div className="console-stat-grid">
          <article>
            <span>Payable now</span>
            <strong>{cedis(preview.sendableTotal)}</strong>
            <small>{preview.candidates.filter((row) => row.status === "PAYABLE").length} of {preview.candidates.length} due organizers, oldest earnings first</small>
          </article>
          <article>
            <span>Waiting on balance</span>
            <strong>{cedis(Math.max(0, preview.payableTotal - preview.sendableTotal))}</strong>
            <small>{cedis(preview.payableTotal)} clears every gate and needs the balance to move it</small>
          </article>
          <article>
            <span>Blocked</span>
            <strong>{preview.candidates.filter((row) => row.status === "BLOCKED").length}</strong>
            <small>refused by a gate rather than by the balance</small>
          </article>
          <article>
            <span>Held back</span>
            <strong>{preview.deferred.length}</strong>
            <small>a standing debt or a transfer already in flight</small>
          </article>
        </div>

        {preview.candidates.length > 0 && <>
          <h3 className="console-subhead">Organizer by organizer</h3>
          <table className="console-table">
            <thead><tr><th>Organizer</th><th>Due</th><th>Entries</th><th>Oldest earning</th><th>Verdict</th></tr></thead>
            <tbody>
              {preview.candidates.map((row) => (
                <tr key={row.organizerId}>
                  <td><span>{row.organization || row.name}</span><small>{row.organization ? row.name : row.organizerId}</small></td>
                  <td><strong className="console-money">{cedis(row.amount)}</strong>{row.fee > 0 && <small>receives {cedis(row.receives)} after the {cedis(row.fee)} transfer fee</small>}</td>
                  <td>{row.entryCount}</td>
                  <td>{whenDue(row.oldest)}</td>
                  <td>
                    <span className={`console-badge ${VERDICT_TONE[row.status] || "console-badge-accrued"}`}>{VERDICT_LABEL[row.status] || row.status}</span>
                    <small>{row.reason ? SKIP_REASONS[row.reason] || row.reason.toLowerCase() : "clears every gate and the balance"}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}

        {preview.candidates.length === 0 && <p className="console-empty">Nothing is due, so there is nothing to plan.</p>}

        {preview.deferred.length > 0 && <>
          <h3 className="console-subhead">Considered and held back</h3>
          <table className="console-table">
            <thead><tr><th>Organizer</th><th>Due</th><th>Entries</th><th>Why they wait</th></tr></thead>
            <tbody>
              {preview.deferred.map((row) => (
                <tr key={`${row.organizerId}-${row.reason}`}>
                  <td><span>{row.organization || row.name}</span><small>{row.organization ? row.name : row.organizerId}</small></td>
                  <td><strong className="console-money">{cedis(row.amount)}</strong></td>
                  <td>{row.entryCount}</td>
                  <td><span className="console-reason">{DEFERRED_REASONS[row.reason] || row.reason.toLowerCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="console-note">A run never picks these up, so they would wait indefinitely without a decision: clear the debt by recording the reversal, or wait for the in-flight transfer to settle and check it above.</p>
        </>}

        <details className="console-disclosure">
          <summary>Why the balance is the limit, and the three ways to fix it</summary>
          <p>
            Paystack settles each collection to the account you nominated, on its own schedule. When the
            settlement account is the bank account, the money is out of Paystack by the time a payout is due,
            so a transfer has nothing local to draw on and the run skips every organizer with
            {" "}<em>the settled balance cannot cover them</em>. Nothing is wrong with the ledger or the
            organizers when that happens — the payout is looking in an empty account.
          </p>
          <ul className="console-runbook">
            <li><strong>Keep the float in Paystack.</strong> Point settlement at the Paystack balance rather than straight to the bank, and withdraw what the platform keeps. The balance then covers payouts and the run stops skipping.</li>
            <li><strong>Top the balance up before a run.</strong> The blunt version of the same fix: transfer in what is due, then run. The panel above tells you the exact figure.</li>
            <li><strong>Pay the organizer directly.</strong> Settle through Paystack splits or subaccounts so each collection leaves the organizer&rsquo;s share behind. This is the durable fix: the money never has to be gathered again.</li>
          </ul>
          <p>
            Unattended runs are a separate switch, and turning them off keeps the ledger and every statement
            working while it is off. The forecast above is the same either way.
          </p>
        </details>
      </>}
    </section>

    <section className="console-panel">
      <h2><Banknote size={18}/>Balances by organizer</h2>
      {organizers.length === 0
        ? <p className="console-empty">No organizer has earned anything yet.</p>
        : <table className="console-table">
          <thead><tr><th>Organizer</th><th>KYC</th><th>Owed</th><th>Due now</th><th>Paid out</th><th>Debt</th><th></th></tr></thead>
          <tbody>
            {organizers.map((row) => (
              <tr key={row.organizerId}>
                <td><span>{row.organization || row.name}</span><small>{row.name} · {row.totals.entries} {row.totals.entries === 1 ? "entry" : "entries"}</small></td>
                <td><span className={`console-badge console-badge-${row.kycStatus.toLowerCase()}`}>{row.kycStatus}</span></td>
                <td><strong className={row.totals.balance < 0 ? "console-money console-reason" : "console-money"}>{cedis(row.totals.balance)}</strong></td>
                <td className="console-money">{row.totals.ready > 0 && row.totals.debt === 0
                  ? <span className="console-badge console-badge-available">{cedis(row.totals.ready)}</span>
                  : cedis(0)}</td>
                <td className="console-money">{cedis(row.totals.released)}</td>
                <td>{row.totals.debt > 0 ? <span className="console-badge console-badge-reversed">{cedis(row.totals.debt)}</span> : "—"}</td>
                <td className="console-row-actions">
                  <button onClick={() => { setSelected(row.organizerId); setError(""); setNotice(""); setRevealed(""); }}>Open statement</button>
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
        <button className="console-panel-close" onClick={() => { setDetail(null); setSelected(""); setRevealed(""); }}>Close</button>
      </h2>

      <div className="console-facts">
        <div className="console-fact"><span>Payout method</span><strong>{detail.organizer.payoutMethod || "Not saved"}</strong><small>{detail.organizer.payoutBankName || "no network recorded"}</small></div>
        <div className="console-fact"><span>Account name</span><strong>{detail.organizer.payoutAccountName || "—"}</strong></div>
        <div className="console-fact">
          <span>Account</span>
          <strong>{revealed || detail.organizer.payoutAccountMasked || "—"}</strong>
          <small>{revealed ? "revealed and audited" : "masked; reveal writes an audit row"}</small>
        </div>
        <div className="console-fact"><span>Commission</span><strong>{(detail.organizer.commissionBps / 100).toFixed(2)}%</strong><small>platform share of each fare</small></div>
        <div className="console-fact"><span>Paystack recipient</span><strong>{detail.organizer.recipientReady ? "Ready" : "Created on first send"}</strong></div>
        <div className="console-fact"><span>Ledger</span><strong>{detail.statement.totals.entries} {detail.statement.totals.entries === 1 ? "entry" : "entries"}</strong><small>{cedis(detail.statement.totals.released)} paid out</small></div>
      </div>

      <div className="console-row-actions">
        <button disabled={busy === "reveal"} onClick={() => void reveal()}>
          <Eye size={15}/>{busy === "reveal" ? "Opening…" : "Reveal account number"}
        </button>
        {revealed && <button onClick={() => void copy(revealed, "Account number")}><Banknote size={15}/>Copy account</button>}
        {!kycVerified && <button disabled={busy === `kyc-${detail.organizer.id}`} onClick={() => void decideKyc(detail.organizer.id, "VERIFY_KYC")}>
          <BadgeCheck size={15}/>{busy === `kyc-${detail.organizer.id}` ? "Saving…" : "Verify KYC"}
        </button>}
        {detail.organizer.kycStatus === "PENDING" && <button disabled={busy === `kyc-${detail.organizer.id}`} onClick={() => void decideKyc(detail.organizer.id, "REJECT_KYC")}>
          <UserX size={15}/>Reject KYC
        </button>}
      </div>

      {detail.organizer.payoutMethod && !detail.organizer.payoutBankName && <div className="console-alert" role="alert">
        <AlertTriangle size={15}/> This account was saved before networks were recorded, so no transfer can be addressed to it. Ask the organizer to save their payout details again.
      </div>}
      {failedEntries > 0 && <div className="console-alert" role="alert">
        <AlertTriangle size={15}/> {failedEntries} {failedEntries === 1 ? "entry has" : "entries have"} stopped retrying after repeated failures.
        <button className="console-panel-close" disabled={busy === "RETRY"} onClick={() => void runAutomation("RETRY", detail.organizer.id)}>
          <Undo2 size={14}/>{busy === "RETRY" ? "Reopening…" : "Retry these entries"}
        </button>
      </div>}
      {totals && totals.debt > 0 && <div className="console-alert" role="alert">
        <AlertTriangle size={15}/> {cedis(totals.debt)} was refunded after it was paid out. The debt is carried forward and blocks the next batch until it is settled.
      </div>}

      <h3 className="console-subhead">Record a payout you made yourself</h3>
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
      {!kycVerified && <p className="console-note">KYC is {detail.organizer.kycStatus}. Verify it with the action above before recording a payout.</p>}
      {kycVerified && !ready && <p className="console-note">
        Nothing is ready to record. An entry becomes payable{" "}
        {automation?.releaseMinutes === 0 ? "as soon as the booking is paid" : `${automation?.releaseMinutes ?? 20} minutes after the booking was paid`}, and a debt blocks the batch.
      </p>}
      {ready && automationReady && <p className="console-note">Running the job pays this automatically. Record only a transfer you made outside Paystack.</p>}

      <h3 className="console-subhead">Ledger entries</h3>
      {detail.statement.entries.length === 0
        ? <p className="console-empty">No ledger entries.</p>
        : <table className="console-table">
          <thead><tr><th>Booking</th><th>Fare</th><th>Commission</th><th>Net</th><th>Release</th><th>Status</th></tr></thead>
          <tbody>
            {detail.statement.entries.map((entry) => (
              <tr key={entry.id}>
                <td><span>{entry.bookingReference || "—"}</span><small>{entry.title || when(entry.createdAt)}</small></td>
                <td className="console-money">{cedis(entry.grossAmount)}</td>
                <td className="console-money">{cedis(entry.commissionAmount)}</td>
                <td><strong className="console-money">{cedis(entry.netAmount)}</strong></td>
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

      <h3 className="console-subhead">Payout batches</h3>
      {detail.statement.batches.length === 0
        ? <p className="console-empty">No payout has been sent or recorded for this organizer.</p>
        : <table className="console-table">
          <thead><tr><th>Date</th><th>Reference</th><th>Entries</th><th>Amount</th><th>Received</th><th>Status</th></tr></thead>
          <tbody>
            {detail.statement.batches.map((batch) => (
              <tr key={batch.id}>
                <td>{when(batch.createdAt)}</td>
                <td><span>{batch.transferReference || "—"}</span><small>{batch.mode}{batch.transferCode ? ` · ${batch.transferCode}` : ""}</small></td>
                <td>{batch.entryCount}</td>
                <td><strong className="console-money">{cedis(batch.totalAmount)}</strong></td>
                <td>
                  <strong className="console-money">{cedis(batch.totalAmount - batch.transferFee)}</strong>
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
      <p className="console-note"><Undo2 size={13}/> A cancelled booking reverses its entry. If it had already been paid out, the reversal becomes a debt that blocks the next batch.</p>
    </section>}
  </ConsoleShell>;
}
