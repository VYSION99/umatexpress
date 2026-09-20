"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BadgeCheck, Banknote, Eye, Loader2, RefreshCw } from "lucide-react";
import { cedis } from "@/components/campusRide/hostel/format";

type PayoutLandlord = {
  id: string; name: string; organization: string; email: string; phone: string;
  status: string; kycStatus: string; commissionBps: number;
  accruedAmount: number; payableAmount: number; payableCount: number; releasedAmount: number; entryCount: number;
  payoutMethod: string; payoutAccountName: string; payoutAccountMasked: string; payoutBankName: string;
  payoutUpdatedAt: string; payoutReady: boolean;
};

type PayoutAccount = {
  method: string; accountName: string; accountMasked: string; last4: string;
  bankCode: string; bankName: string; updatedAt: string; ready: boolean;
};

type PayoutEntry = {
  id: string; bookingReference: string; propertyName: string; studentName: string; periodName: string;
  grossAmount: number; commissionAmount: number; netAmount: number;
  status: string; releaseAfter: string; releasedAt: string; transferReference: string; createdAt: string;
};

type PayoutBatch = {
  id: string; totalAmount: number; entryCount: number; transferReference: string; note: string; createdBy: string; createdAt: string;
  mode: string; status: string; transferCode: string; reason: string; settledAt: string;
};

type Statement = {
  landlord: PayoutLandlord;
  account: PayoutAccount;
  entries: PayoutEntry[];
  batches: PayoutBatch[];
  totals: { accruedAmount: number; payableAmount: number; releasedAmount: number };
};

type Overview = {
  landlords: PayoutLandlord[];
  totals: { accruedAmount: number; payableAmount: number; releasedAmount: number; payableCount: number };
  balance: { payableAmount: number; accruedAmount: number; releasedAmount: number; commissionAmount: number };
  auto?: { enabled: boolean; source: string };
};

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

/**
 * The hostel money desk: every landlord with ledger rows, the part of their
 * balance that has left its release window, and the transfers behind it. Money
 * leaves through Paystack (the send button), and an entry is only marked paid
 * once Paystack says the transfer settled — a manual record stays for the
 * transfer that had to be made by hand.
 */
export function HostelPayoutDesk() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [revealed, setRevealed] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/console/hostel/payouts", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as Overview & { error?: string };
    if (!response.ok) throw new Error(data.error || "The payout ledger could not be loaded.");
    setOverview({ landlords: data.landlords || [], totals: data.totals, balance: data.balance, auto: data.auto });
  }, []);

  const open = useCallback(async (landlordId: string) => {
    const response = await fetch(`/api/console/hostel/payouts?landlordId=${encodeURIComponent(landlordId)}`, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as Statement & { error?: string };
    if (!response.ok) throw new Error(data.error || "That statement could not be loaded.");
    setStatement({ landlord: data.landlord, account: data.account, entries: data.entries || [], batches: data.batches || [], totals: data.totals });
    setRevealed("");
    setReference("");
    setNote("");
  }, []);

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

  async function record(event: FormEvent) {
    event.preventDefault();
    if (!statement) return;
    await run(async () => {
      setBusy("record");
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/payouts", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ landlordId: statement.landlord.id, reference, note }),
        });
        const data = await response.json() as { batch?: PayoutBatch; error?: string };
        if (!response.ok) throw new Error(data.error || "That payout could not be recorded.");
        setNotice(`${cedis(data.batch?.totalAmount || 0)} released under ${data.batch?.transferReference || reference}.`);
        await open(statement.landlord.id);
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  /**
   * Sends the payable balance through Paystack. The entries are claimed by the
   * batch, so a double-click cannot pay twice: the second call finds a transfer
   * already in flight and says so.
   */
  async function send() {
    if (!statement) return;
    await run(async () => {
      setBusy("send");
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/payouts", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "SEND", landlordId: statement.landlord.id, note }),
        });
        const data = await response.json() as { batch?: PayoutBatch; status?: string; error?: string };
        if (!response.ok) throw new Error(data.error || "That transfer could not be sent.");
        setNotice(data.status === "RELEASED"
          ? `${cedis(data.batch?.totalAmount || 0)} sent to ${statement.landlord.name} through Paystack.`
          : `${cedis(data.batch?.totalAmount || 0)} is in flight with Paystack. It releases when the transfer settles.`);
        await open(statement.landlord.id);
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  /** The stuck-transfer button: ask Paystack what happened, then settle or return. */
  async function reconcile() {
    await run(async () => {
      setBusy("reconcile");
      setNotice("");
      try {
        const response = await fetch("/api/console/hostel/payouts", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "RECONCILE" }),
        });
        const data = await response.json() as { result?: { scanned: number; settled: number; failed: number; stillPending: number }; error?: string };
        if (!response.ok) throw new Error(data.error || "The transfers could not be reconciled.");
        const result = data.result;
        setNotice(result
          ? `Checked ${result.scanned} in-flight transfer${result.scanned === 1 ? "" : "s"}: ${result.settled} settled, ${result.failed} returned to the ledger, ${result.stillPending} still pending.`
          : "Nothing was in flight.");
        if (statement) await open(statement.landlord.id);
        await load();
      } finally {
        setBusy("");
      }
    });
  }

  if (!overview) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading the payout ledger…</p>;

  const now = new Date().toISOString();

  return <>
    <section className="console-totals">
      <article><span>PAYABLE NOW</span><strong>{cedis(overview.balance.payableAmount)}</strong><small>{overview.totals.payableCount} entries released</small></article>
      <article><span>STILL HELD</span><strong>{cedis(overview.balance.accruedAmount)}</strong><small>inside the release window</small></article>
      <article><span>PAID OUT</span><strong>{cedis(overview.balance.releasedAmount)}</strong><small>recorded transfers</small></article>
      <article><span>PLATFORM 3%</span><strong>{cedis(overview.balance.commissionAmount)}</strong><small>kept from bed payments</small></article>
    </section>

    {overview.auto && <p className="console-note">
      {overview.auto.enabled
        ? <>Automatic releases are on, so a due balance leaves without anyone watching. <Link href="/console/settings">Platform settings</Link>.</>
        : <>Automatic releases are off, so money only moves when you press Send. <Link href="/console/settings">Turn them on in Platform settings</Link>.</>}
    </p>}

    <section className="console-panel">
      <h2><Banknote size={18} aria-hidden />Landlords owed
        <button type="button" className="console-panel-close" onClick={() => void run(load)}><RefreshCw size={14} aria-hidden />Refresh</button>
      </h2>
      {error && <div className="console-alert" role="alert">{error}</div>}
      {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
      {overview.landlords.length === 0
        ? <p className="console-empty">No landlord has earned anything yet. A paid hostel booking accrues here automatically.</p>
        : <table className="console-table">
          <thead><tr><th>Landlord</th><th>KYC</th><th>Ready to pay</th><th>Held</th><th>Paid out</th><th>Account</th><th></th></tr></thead>
          <tbody>
            {overview.landlords.map((landlord) => <tr key={landlord.id}>
              <td><strong>{landlord.name}</strong><small>{landlord.organization || landlord.email}</small></td>
              <td><span className={`console-badge console-badge-${landlord.kycStatus.toLowerCase()}`}>{landlord.kycStatus}</span></td>
              <td><strong>{cedis(landlord.payableAmount)}</strong><small>{landlord.payableCount} entries</small></td>
              <td>{cedis(landlord.accruedAmount - landlord.payableAmount)}</td>
              <td>{cedis(landlord.releasedAmount)}</td>
              <td>{landlord.payoutReady
                ? <><span>{landlord.payoutAccountMasked}</span><small>{landlord.payoutAccountName} · {landlord.payoutBankName || landlord.payoutMethod}</small></>
                : <span className="console-badge console-badge-draft">Not saved</span>}</td>
              <td className="console-row-actions">
                <button type="button" disabled={busy === landlord.id} onClick={() => void run(() => open(landlord.id))}>Open statement</button>
              </td>
            </tr>)}
          </tbody>
        </table>}
    </section>

    {statement && <section className="console-panel">
      <h2><Banknote size={18} aria-hidden />{statement.landlord.name}
        <button type="button" className="console-panel-close" disabled={busy === "reconcile"} onClick={() => void reconcile()}>
          <RefreshCw size={14} aria-hidden />{busy === "reconcile" ? "Checking…" : "Reconcile transfers"}
        </button>
        <button type="button" className="console-panel-close" onClick={() => { setStatement(null); setRevealed(""); }}>Close</button>
      </h2>
      <section className="console-totals">
        <article><span>READY</span><strong>{cedis(statement.totals.payableAmount)}</strong><small>may be transferred today</small></article>
        <article><span>HELD</span><strong>{cedis(statement.totals.accruedAmount)}</strong><small>releases before the year starts</small></article>
        <article><span>PAID</span><strong>{cedis(statement.totals.releasedAmount)}</strong><small>{statement.batches.length} transfers</small></article>
        <article><span>RATE</span><strong>{(statement.landlord.commissionBps / 100).toFixed(2)}%</strong><small>platform commission</small></article>
      </section>

      <p className="console-note">
        {statement.account.ready
          ? <>{statement.account.accountName} · {statement.account.bankName || statement.account.method} {statement.account.accountMasked}. </>
          : <>This landlord has not saved a payout account, so a transfer cannot be recorded. </>}
        {revealed
          ? <strong>Full number: {revealed} — this reveal was written to the audit log.</strong>
          : <button
            type="button"
            className="console-inline-link"
            disabled={busy === "reveal"}
            onClick={() => void run(async () => {
              setBusy("reveal");
              try {
                const response = await fetch(`/api/console/hostel/payout-account?landlordId=${encodeURIComponent(statement.landlord.id)}&reveal=1`, { credentials: "same-origin", cache: "no-store" });
                const data = await response.json() as { accountNumber?: string; error?: string };
                if (!response.ok) throw new Error(data.error || "That account could not be revealed.");
                setRevealed(data.accountNumber || "");
              } finally {
                setBusy("");
              }
            })}
          ><Eye size={14} aria-hidden />Reveal full number</button>}
      </p>

      <form className="console-form" onSubmit={record}>
        <label>Transfer reference
          <input type="text" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={80} placeholder="Mobile money or bank reference" />
        </label>
        <label>Note
          <input type="text" value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Optional" />
        </label>
        <button
          type="button"
          disabled={busy === "send" || !statement.account.ready || statement.totals.payableAmount <= 0}
          onClick={() => void send()}
        >
          {busy === "send" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Banknote size={15} aria-hidden />}
          Send {cedis(statement.totals.payableAmount)} with Paystack
        </button>
        <button type="submit" className="console-secondary" disabled={busy === "record" || reference.trim().length < 3 || statement.totals.payableAmount <= 0}>
          {busy === "record" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <BadgeCheck size={15} aria-hidden />}
          Record a transfer made by hand
        </button>
      </form>

      <h3 className="console-subhead">Ledger entries</h3>
      {statement.entries.length === 0
        ? <p className="console-empty">Nothing in this ledger yet.</p>
        : <table className="console-table">
          <thead><tr><th>Resident</th><th>Bed</th><th>Paid</th><th>Commission</th><th>Net</th><th>Release</th></tr></thead>
          <tbody>
            {statement.entries.map((entry) => <tr key={entry.id}>
              <td><strong>{entry.studentName || "Student"}</strong><small>{entry.bookingReference} · {entry.periodName}</small></td>
              <td>{entry.propertyName}</td>
              <td>{cedis(entry.grossAmount)}</td>
              <td>{cedis(entry.commissionAmount)}</td>
              <td><strong>{cedis(entry.netAmount)}</strong></td>
              <td>{entry.status === "RELEASED"
                ? <><span className="console-badge console-badge-released">Paid</span><small>{when(entry.releasedAt)} · {entry.transferReference}</small></>
                : entry.releaseAfter <= now
                  ? <span className="console-badge console-badge-active">Ready</span>
                  : <><span className="console-badge console-badge-accrued">Held</span><small>{when(entry.releaseAfter)}</small></>}</td>
            </tr>)}
          </tbody>
        </table>}

      {statement.batches.length > 0 && <>
        <h3 className="console-subhead">Transfers</h3>
        <table className="console-table">
          <thead><tr><th>Reference</th><th>How</th><th>Entries</th><th>Amount</th><th>Recorded</th><th>By</th></tr></thead>
          <tbody>
            {statement.batches.map((batch) => <tr key={batch.id}>
              <td><strong>{batch.transferReference}</strong>{batch.note ? <small>{batch.note}</small> : null}</td>
              <td>
                <span className={`console-badge console-badge-${batch.status === "RELEASED" || batch.status === "RECORDED" ? "released" : batch.status === "FAILED" ? "draft" : "active"}`}>
                  {batch.status === "RECORDED" ? "By hand" : batch.status}
                </span>
                {batch.reason ? <small>{batch.reason}</small> : null}
              </td>
              <td>{batch.entryCount}</td>
              <td>{cedis(batch.totalAmount)}</td>
              <td>{when(batch.createdAt)}</td>
              <td>{batch.createdBy}</td>
            </tr>)}
          </tbody>
        </table>
      </>}
    </section>}
  </>;
}
