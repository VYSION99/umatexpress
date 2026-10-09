"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Bed, CalendarBlank, Check, Plus, ShieldWarning, X } from "@/components/ui/MaterialIcon";
import { SheetHandle } from "@/components/ui/SheetHandle";
import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { PropertyVerificationReview } from "@/components/console/hostel/PropertyVerificationReview";
import { PhotoReviewQueue } from "@/components/console/hostel/PhotoReviewQueue";
import { HostelOnboardingReview } from "@/components/console/hostel/HostelOnboardingReview";
import "@/components/console/hostel/onboarding-review.css";
import "@/components/console/hostel/review-layout.css";

type Listing = {
  id: string; spaceId: string; periodId: string; price: number; status: string;
  reviewReason: string; submittedAt: string; reviewedAt: string; reviewedBy: string;
  propertyId: string; propertyName: string; roomId: string; roomLabel: string; spaceLabel: string;
  periodName: string; periodStartsOn: string; propertyStatus: string;
  landlordName: string; landlordPhone: string; landlordKycStatus: string;
};

type Period = { id: string; name: string; startsOn: string; endsOn: string; active: boolean; createdAt: string };
type RoomGroup = {
  key: string; roomId: string; periodId: string; propertyName: string; roomLabel: string;
  periodName: string; landlordName: string; landlordPhone: string; price: number;
  submittedAt: string; reviewedAt: string; listings: Listing[]; mixedPrices: boolean;
};
function groupByRoom(listings: Listing[]): RoomGroup[] {
  const grouped = new Map<string, RoomGroup>();
  for (const listing of listings) {
    const key = `${listing.roomId}:${listing.periodId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.listings.push(listing);
      existing.mixedPrices ||= existing.price !== listing.price;
    } else {
      grouped.set(key, {
        key, roomId: listing.roomId, periodId: listing.periodId, propertyName: listing.propertyName,
        roomLabel: listing.roomLabel, periodName: listing.periodName, landlordName: listing.landlordName,
        landlordPhone: listing.landlordPhone, price: listing.price, submittedAt: listing.submittedAt,
        reviewedAt: listing.reviewedAt, listings: [listing], mixedPrices: false,
      });
    }
  }
  return [...grouped.values()];
}

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
  const approveAllDialog = useRef<HTMLDialogElement>(null);
  const pendingRooms = groupByRoom(queue || []);
  const liveRooms = groupByRoom(live || []);

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

  async function decideRoom(room: RoomGroup, action: "APPROVE" | "REJECT" | "SUSPEND") {
    setBusy(room.key); setError(""); setSaved("");
    try {
      const response = await fetch("/api/console/hostel/listings/review", {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action, scope: "ROOM", roomId: room.roomId, periodId: room.periodId,
          expectedListingIds: room.listings.map(item => item.id), reason: reasons[room.key] || "",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That room decision could not be saved.");
      setSaved(action === "APPROVE"
        ? `${room.propertyName} · ${room.roomLabel}: ${data.review.listingCount} beds are live for ${room.periodName}.`
        : action === "SUSPEND"
          ? `${room.roomLabel}: ${data.review.listingCount} beds are hidden from students.`
          : `${room.roomLabel} was sent back to ${room.landlordName || "the landlord"} with your reason.`);
      setReasons(current => ({ ...current, [room.key]: "" }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That room decision could not be saved.");
    } finally { setBusy(""); }
  }

  async function approveAll() {
    if (!queue?.length) return;
    setBusy("all"); setError(""); setSaved("");
    try {
      const response = await fetch("/api/console/hostel/listings/review", {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "APPROVE", scope: "ALL", expectedListingIds: queue.map(item => item.id) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The rooms could not all be approved.");
      approveAllDialog.current?.close();
      setSaved(`${data.review.roomCount} rooms and ${data.review.listingCount} beds are live.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The rooms could not all be approved.");
    } finally { setBusy(""); }
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

  return <div className="hostel-review-workspace">
    <div className="hostel-review-intro"><div><span>HOSTEL REVIEW DESK</span><h2>Decisions, clearly separated</h2><p>Review evidence and property details separately, then decide each room’s annual rate once for all its submitted beds.</p></div><div className="hostel-review-counts"><strong>{queue ? pendingRooms.length : "—"}<small>rooms waiting · {queue?.length ?? 0} beds</small></strong><strong>{live ? liveRooms.length : "—"}<small>live rooms · {live?.length ?? 0} beds</small></strong></div></div>
    <nav className="hostel-review-jumps" aria-label="Review sections"><a href="#hostel-review-photos">Photos</a><a href="#hostel-review-claims">Details</a><a href="#hostel-review-onboarding">Accounts</a><a href="#hostel-review-pending">Room rates</a><a href="#hostel-review-live">Live</a>{isAdmin && <a href="#hostel-review-years">Years</a>}</nav>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <div id="hostel-review-photos"><PhotoReviewQueue onNotice={setSaved} /></div>
    <div id="hostel-review-claims"><PropertyVerificationReview /></div>
    <div id="hostel-review-onboarding"><HostelOnboardingReview /></div>

    <section className="console-panel" id="hostel-review-pending">
      <div className="hostel-review-section-heading"><h2><Bed size={18}/>Rooms waiting for review
        {queue && <span className="console-badge">{pendingRooms.length}</span>}</h2>
        {isAdmin && pendingRooms.length > 0 && <button type="button" className="hostel-review-approve-all" disabled={Boolean(busy)} onClick={() => approveAllDialog.current?.showModal()}><Check size={16}/>Approve all rooms</button>}
      </div>
      {!queue
        ? <p className="console-empty">Loading the queue…</p>
        : pendingRooms.length === 0
          ? <p className="console-empty">No room rates are waiting for a decision.</p>
          : <table className="console-table hostel-review-listing-table">
            <thead><tr><th>Room</th><th>Landlord</th><th>Year and rate</th><th>Decision</th></tr></thead>
            <tbody>
              {pendingRooms.map((room) => (
                <tr key={room.key}>
                  <td data-label="Room"><strong>{room.propertyName}</strong><small>{room.roomLabel} · {room.listings.length} submitted {room.listings.length === 1 ? "bed" : "beds"}</small><details><summary>See bed names</summary><small>{room.listings.map(item => item.spaceLabel).join(", ")}</small></details></td>
                  <td data-label="Landlord"><span>{room.landlordName || "—"}</span><small>{room.landlordPhone}</small></td>
                  <td data-label="Year"><span>{room.periodName}</span><small>{room.mixedPrices ? "Rates differ — ask landlord to correct them" : `${cedis(room.price)} per student bed`} · submitted {when(room.submittedAt)}</small></td>
                  <td className="console-row-actions" data-label="Decision">
                    <input type="text" aria-label={`Reason for ${room.propertyName} ${room.roomLabel}`} placeholder="Reason (needed to reject)" maxLength={200} value={reasons[room.key] || ""} onChange={event => setReasons({ ...reasons, [room.key]: event.target.value })}/>
                    <button disabled={Boolean(busy) || room.mixedPrices} onClick={() => void decideRoom(room, "APPROVE")}><Check size={15}/>Approve room</button>
                    <button disabled={Boolean(busy) || !reasons[room.key]?.trim()} onClick={() => void decideRoom(room, "REJECT")}><X size={15}/>Reject room</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      <p className="console-note">One room decision applies to every submitted bed in that room for this academic year. The owner, property and yearly rate must pass review before any bed goes live.</p>
    </section>

    <section className="console-panel" id="hostel-review-live">
      <h2><ShieldWarning size={18}/>Live room rates {live && <span className="console-badge">{liveRooms.length}</span>}</h2>
      {!live ? <p className="console-empty">Loading live rooms…</p> : liveRooms.length === 0
        ? <p className="console-empty">No approved rooms yet.</p>
        : <table className="console-table hostel-review-listing-table">
          <thead><tr><th>Room</th><th>Landlord</th><th>Year and rate</th><th>Action</th></tr></thead>
          <tbody>{liveRooms.map(room => <tr key={room.key}>
            <td data-label="Room"><strong>{room.propertyName}</strong><small>{room.roomLabel} · {room.listings.length} live {room.listings.length === 1 ? "bed" : "beds"}</small></td>
            <td data-label="Landlord"><span>{room.landlordName || "—"}</span><small>{room.landlordPhone}</small></td>
            <td data-label="Year"><span>{room.periodName}</span><small>{room.mixedPrices ? "Mixed rates" : `${cedis(room.price)} per student bed`} · live since {when(room.reviewedAt)}</small></td>
            <td className="console-row-actions" data-label="Action">{isAdmin ? <>
              <input type="text" aria-label={`Reason for suspending ${room.propertyName} ${room.roomLabel}`} placeholder="Reason to suspend" maxLength={200} value={reasons[room.key] || ""} onChange={event => setReasons({ ...reasons, [room.key]: event.target.value })}/>
              <button disabled={Boolean(busy) || !reasons[room.key]?.trim()} onClick={() => void decideRoom(room, "SUSPEND")}><ShieldWarning size={15}/>Suspend room</button>
            </> : <span className="console-note">An administrator can suspend this room.</span>}</td>
          </tr>)}</tbody>
        </table>}
      <p className="console-note">Suspending a room hides its approved beds together. Existing booking records remain intact.</p>
    </section>

    <dialog ref={approveAllDialog} className="hostel-review-bulk-dialog" aria-labelledby="hostel-approve-all-title" onCancel={event => { if (busy === "all") event.preventDefault(); }} onClick={event => { if (event.target === event.currentTarget && busy !== "all") approveAllDialog.current?.close(); }}>
      <SheetHandle onDismiss={() => approveAllDialog.current?.close()} disabled={busy === "all"} />
      <h2 id="hostel-approve-all-title">Approve all pending rooms?</h2>
      <p>This will publish {pendingRooms.length} room rates covering {queue?.length ?? 0} submitted beds. Review the rooms and prices above before continuing. If the queue changes, the decision will stop and ask you to refresh.</p>
      {error && <p className="hostel-review-bulk-error" role="alert">{error}</p>}
      <div><button type="button" disabled={busy === "all"} onClick={() => approveAllDialog.current?.close()}>Cancel</button><button type="button" disabled={Boolean(busy) || pendingRooms.some(room => room.mixedPrices)} onClick={() => void approveAll()}><Check size={16}/>{busy === "all" ? "Approving…" : "Approve all rooms"}</button></div>
    </dialog>

    {isAdmin && <section className="console-panel" id="hostel-review-years">
      <h2><CalendarBlank size={18}/>Academic years</h2>
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
        : <table className="console-table hostel-review-listing-table">
          <thead><tr><th>Year</th><th>Starts</th><th>Ends</th><th>State</th><th></th></tr></thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period.id}>
                <td data-label="Year"><strong>{period.name}</strong><small>Added {when(period.createdAt)}</small></td>
                <td data-label="Starts">{when(period.startsOn)}</td>
                <td data-label="Ends">{when(period.endsOn)}</td>
                <td data-label="State"><span className={badge(period.active ? "APPROVED" : "SUSPENDED")}>{period.active ? "OPEN" : "CLOSED"}</span></td>
                <td className="console-row-actions" data-label="Action">
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
  </div>;
}
