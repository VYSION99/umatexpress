"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BedDouble, CalendarClock, Check, Plus, ShieldAlert, X } from "lucide-react";
import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";

type Listing = {
  id: string; spaceId: string; periodId: string; price: number; status: string;
  reviewReason: string; submittedAt: string; reviewedAt: string; reviewedBy: string;
  propertyId: string; propertyName: string; roomLabel: string; spaceLabel: string;
  periodName: string; periodStartsOn: string; propertyStatus: string;
  landlordName: string; landlordPhone: string; landlordKycStatus: string;
};

type Period = { id: string; name: string; startsOn: string; endsOn: string; active: boolean; createdAt: string };

const cedis = (pesewas: number) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const badge = (status: string) => `console-badge console-badge-${status.toLowerCase()}`;

/**
 * The hostel side of the console for staff: decide the beds students may book,
 * pulling one that has gone wrong, and keep the academic-year catalogue every
 * listing is priced against. A moderator reviews; an administrator also keeps
 * the catalogue and can suspend something that is already live.
 */
export function HostelReviewQueue({ session }: { session: ConsoleSessionInfo }) {
  const isAdmin = session.account.role === "ADMIN";
  const [queue, setQueue] = useState<Listing[] | null>(null);
  const [live, setLive] = useState<Listing[] | null>(null);
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ name: "", startsOn: "", endsOn: "" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [queueResponse, liveResponse] = await Promise.all([
        fetch("/api/console/hostel/listings/review", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/console/hostel/listings/review?status=APPROVED", { credentials: "same-origin", cache: "no-store" }),
      ]);
      const queueData = await queueResponse.json();
      if (!queueResponse.ok) throw new Error(queueData.error || "The review queue could not be loaded.");
      const liveData = await liveResponse.json();
      if (!liveResponse.ok) throw new Error(liveData.error || "Live listings could not be loaded.");
      setQueue(queueData.listings || []);
      setLive(liveData.listings || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The review queue could not be loaded.");
    }
  }, []);

  const loadPeriods = useCallback(async () => {
    const response = await fetch("/api/admin/hostel/periods", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The academic years could not be loaded.");
    setPeriods(data.periods || []);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
      if (isAdmin) loadPeriods().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "The academic years could not be loaded."));
    });
  }, [isAdmin, load, loadPeriods]);

  async function decide(listing: Listing, action: "APPROVE" | "REJECT" | "SUSPEND") {
    setBusy(listing.id); setError(""); setSaved("");
    try {
      const response = await fetch(`/api/console/hostel/listings/${encodeURIComponent(listing.id)}/review`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reasons[listing.id] || "" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That decision could not be saved.");
      setSaved(action === "APPROVE"
        ? `${listing.propertyName} · ${listing.roomLabel} ${listing.spaceLabel} is live for ${listing.periodName}.`
        : action === "SUSPEND"
          ? `${listing.roomLabel} ${listing.spaceLabel} is suspended and hidden from students.`
          : `Sent back to ${listing.landlordName || "the landlord"} with your reason.`);
      setReasons((current) => ({ ...current, [listing.id]: "" }));
      await load();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "That decision could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function addPeriod(event: FormEvent) {
    event.preventDefault();
    setBusy("period"); setError(""); setSaved("");
    try {
      const response = await fetch("/api/admin/hostel/periods", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The academic year could not be saved.");
      setDraft({ name: "", startsOn: "", endsOn: "" });
      setSaved(`${data.period.name} is open. Landlords can price beds against it now.`);
      await loadPeriods();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The academic year could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function closePeriod(period: Period) {
    setBusy(period.id); setError(""); setSaved("");
    try {
      const response = await fetch("/api/admin/hostel/periods", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ periodId: period.id, action: "CLOSE" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That year could not be closed.");
      setSaved(`${period.name} is closed to new listings. The beds already sold stay live.`);
      await loadPeriods();
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : "That year could not be closed.");
    } finally {
      setBusy("");
    }
  }

  return <>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <section className="console-panel">
      <h2><BedDouble size={18}/>Waiting for review
        {queue && <span className="console-badge">{queue.length}</span>}
      </h2>
      {!queue
        ? <p className="console-empty">Loading the queue…</p>
        : queue.length === 0
          ? <p className="console-empty">Nothing is waiting. Approved beds appear under live listings.</p>
          : <table className="console-table">
            <thead><tr><th>Bed</th><th>Landlord</th><th>Year</th><th>Decision</th></tr></thead>
            <tbody>
              {queue.map((listing) => (
                <tr key={listing.id}>
                  <td>
                    <strong>{listing.propertyName}</strong>
                    <small>{listing.roomLabel} · {listing.spaceLabel}</small>
                  </td>
                  <td>
                    <span>{listing.landlordName || "—"}</span>
                    <small>{listing.landlordPhone}</small>
                  </td>
                  <td>
                    <span>{listing.periodName}</span>
                    <small>{cedis(listing.price)} · submitted {when(listing.submittedAt)}</small>
                  </td>
                  <td className="console-row-actions">
                    <input
                      type="text"
                      aria-label={`Reason for ${listing.propertyName} ${listing.spaceLabel}`}
                      placeholder="Reason (needed to reject)"
                      maxLength={200}
                      value={reasons[listing.id] || ""}
                      onChange={(event) => setReasons({ ...reasons, [listing.id]: event.target.value })}
                    />
                    <button disabled={busy === listing.id} onClick={() => void decide(listing, "APPROVE")}><Check size={15}/>Approve</button>
                    <button disabled={busy === listing.id} onClick={() => void decide(listing, "REJECT")}><X size={15}/>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      <p className="console-note">
        Approving a bed publishes it for the year and accepts the building with it. A rejection needs a reason: it goes back to the landlord as a draft they can fix.
      </p>
    </section>

    <section className="console-panel">
      <h2><ShieldAlert size={18}/>Live listings
        {live && <span className="console-badge">{live.length}</span>}
      </h2>
      {!live
        ? <p className="console-empty">Loading live listings…</p>
        : live.length === 0
          ? <p className="console-empty">No approved beds yet.</p>
          : <table className="console-table">
            <thead><tr><th>Bed</th><th>Landlord</th><th>Year</th><th></th></tr></thead>
            <tbody>
              {live.map((listing) => (
                <tr key={listing.id}>
                  <td><strong>{listing.propertyName}</strong><small>{listing.roomLabel} · {listing.spaceLabel}</small></td>
                  <td><span>{listing.landlordName || "—"}</span><small>{listing.landlordPhone}</small></td>
                  <td><span>{listing.periodName}</span><small>{cedis(listing.price)} · live since {when(listing.reviewedAt)}</small></td>
                  <td className="console-row-actions">
                    {isAdmin
                      ? <>
                        <input
                          type="text"
                          aria-label={`Reason for suspending ${listing.propertyName} ${listing.spaceLabel}`}
                          placeholder="Reason to suspend"
                          maxLength={200}
                          value={reasons[listing.id] || ""}
                          onChange={(event) => setReasons({ ...reasons, [listing.id]: event.target.value })}
                        />
                        <button disabled={busy === listing.id} onClick={() => void decide(listing, "SUSPEND")}><ShieldAlert size={15}/>Suspend</button>
                      </>
                      : <span className="console-note">An administrator can suspend a live bed.</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      <p className="console-note">
        Suspending hides a bed from students immediately and keeps its record. Fix the problem with the landlord, then they submit it again for review.
      </p>
    </section>

    {isAdmin && <section className="console-panel">
      <h2><CalendarClock size={18}/>Academic years</h2>
      <form className="console-form" onSubmit={addPeriod}>
        <label>Year name
          <input type="text" required minLength={8} maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="2026/27 Academic Year" />
        </label>
        <label>Students arrive
          <input type="date" required value={draft.startsOn} onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })} />
        </label>
        <label>Year ends
          <input type="date" required value={draft.endsOn} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} />
        </label>
        <button disabled={busy === "period"}><Plus size={16}/>{busy === "period" ? "Saving…" : "Open the year"}</button>
      </form>
      {!periods
        ? <p className="console-empty">Loading the catalogue…</p>
        : <table className="console-table">
          <thead><tr><th>Year</th><th>Starts</th><th>Ends</th><th>State</th><th></th></tr></thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period.id}>
                <td><strong>{period.name}</strong><small>Added {when(period.createdAt)}</small></td>
                <td>{when(period.startsOn)}</td>
                <td>{when(period.endsOn)}</td>
                <td><span className={badge(period.active ? "APPROVED" : "SUSPENDED")}>{period.active ? "OPEN" : "CLOSED"}</span></td>
                <td className="console-row-actions">
                  {period.active && <button disabled={busy === period.id} onClick={() => void closePeriod(period)}><X size={15}/>Close year</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
      <p className="console-note">
        Landlords price beds against an open year only. Closing a year stops new listings but never disturbs the beds already sold for it.
      </p>
    </section>}
  </>;
}
