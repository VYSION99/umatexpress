"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowClockwise, ArrowRight, Buildings, CalendarBlank, Chat, MagnifyingGlass, Users } from "@/components/ui/MaterialIcon";
import { ResidencyDialog } from "@/components/campusRide/hostel/ResidencyDialog";
import { cedis } from "@/components/campusRide/hostel/format";
import type { HostelBooking } from "@/lib/hostel-engine/residency";
import type { StayAction } from "@/lib/hostel-engine/stays";

type Resident = HostelBooking & { unreadMessages: number; openServices: number };
type Option = { id: string; name: string };
type Summary = { total: number; resident: number; expected: number; departed: number; bedRevenue: number; openServices: number; unreadMessages: number };
type List = { residents: Resident[]; summary: Summary; isOwner: boolean; pagination: { page: number; pages: number; total: number; pageSize: number } };
type Detail = { booking: HostelBooking; stay: { key_reference?: string }; destinations: { listing_id: string; room_label: string; space_label: string }[]; events: { id: string; action: string; actor: string; details: string; created_at: string }[] };
const label: Record<string, string> = { EXPECTED: "Expected arrival", CHECKED_IN: "Checked in", CHECKED_OUT: "Checked out", NO_SHOW: "No-show", CANCELLED: "Cancelled", REFUNDED: "Refunded", PAID: "Paid", PENDING_PAYMENT: "Awaiting payment", PAYMENT_REVIEW: "Payment review", EXPIRED: "Expired", SCHEDULE: "Arrival updated", CHECK_IN: "Check-in", CHECK_OUT: "Checkout", TRANSFER: "Bed transfer" };
const date = (value: string) => value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Not recorded";
function state(booking: HostelBooking) { return booking.status === "PAID" ? booking.stayStatus : booking.status; }
async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The resident information could not be loaded.");
  return data as T;
}

export function ResidentRoster({ properties, periods, refreshKey, onOwner, onMessage }: {
  properties: Option[]; periods: Option[]; refreshKey: number; onOwner: (owner: boolean) => void;
  onMessage: (resident: { reference: string; name: string }) => void;
}) {
  const [filters, setFilters] = useState({ propertyId: "", periodId: "", status: "", q: "", page: 1 });
  const [search, setSearch] = useState("");
  const [data, setData] = useState<List | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Resident | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const id = ++sequence.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ ...filters, page: String(filters.page) });
      const result = await read<List>("/api/console/hostel/residents?" + params);
      if (sequence.current !== id) return;
      setData(result); onOwner(result.isOwner);
    } catch (cause) { if (sequence.current === id) setError(cause instanceof Error ? cause.message : "Residents could not load."); }
    finally { if (sequence.current === id) setLoading(false); }
  }, [filters, onOwner]);
  useEffect(() => { const requestSequence = sequence; queueMicrotask(() => void load()); return () => { requestSequence.current++; }; }, [load, refreshKey]);
  const change = (key: "propertyId" | "periodId" | "status", value: string) => setFilters(current => ({ ...current, [key]: value, page: 1 }));
  const filterFields = <>
    <label>Property<select value={filters.propertyId} onChange={event => change("propertyId", event.target.value)}><option value="">All properties</option>{properties.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Academic year<select value={filters.periodId} onChange={event => change("periodId", event.target.value)}><option value="">All academic years</option>{periods.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Status<select value={filters.status} onChange={event => change("status", event.target.value)}><option value="">All statuses</option>{["EXPECTED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW", "CANCELLED", "REFUNDED"].map(value => <option key={value} value={value}>{label[value]}</option>)}</select></label>
  </>;
  return <div className="resident-roster">
    {data && <section className="residency-stats" aria-label="Property and academic year totals">
      <article><CalendarBlank size={20} aria-hidden /><span>Expected</span><strong>{data.summary.expected}</strong></article>
      <article><Users size={20} aria-hidden /><span>Checked in</span><strong>{data.summary.resident}</strong></article>
      <article><ArrowRight size={20} aria-hidden /><span>Departed / no-show</span><strong>{data.summary.departed}</strong></article>
      <article><Chat size={20} aria-hidden /><span>Open requests</span><strong>{data.summary.openServices}</strong></article>
    </section>}
    <div className="residency-roster-heading"><div><p>RESIDENT DIRECTORY</p><h3>People, rooms & arrivals</h3><span>{data ? `${data.summary.total} confirmed stays · ${cedis(data.summary.bedRevenue)} paid` : "Loading your directory"} · {periods.find(item => item.id === filters.periodId)?.name || "All academic years"}</span></div><button type="button" className="residency-icon-button" aria-label="Refresh residents" disabled={loading} onClick={() => void load()}><ArrowClockwise size={20} /></button></div>
    <div className="residency-search-row"><form onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, q: search.trim(), page: 1 })); }}><label><MagnifyingGlass size={19} aria-hidden /><input aria-label="Find a resident by name, email, room or reference" placeholder="Search name, room or reference" value={search} onChange={event => setSearch(event.target.value)} maxLength={80} /></label><button type="submit">Search</button></form><button className="residency-mobile-filter" type="button" onClick={() => setFilterOpen(true)}>Filters</button></div>
    <div className="residency-filters">{filterFields}</div>
    {error && <p className="residency-alert" role="alert">{error} <button type="button" onClick={() => void load()}>Retry</button></p>}
    <div aria-busy={loading}>
      {loading && <p className="residency-loading" role="status">Updating residents…</p>}
      {!loading && data?.residents.length === 0 && <div className="residency-empty"><Users size={28} /><h3>{data.pagination.total === 0 && !filters.propertyId && !filters.periodId && !filters.status && !filters.q ? "No confirmed residents yet" : "No residents match these filters"}</h3><p>{data.pagination.total === 0 && !filters.propertyId && !filters.periodId && !filters.status && !filters.q ? "Students appear here after their bed payment is confirmed." : "Try another property, academic year or search."}</p></div>}
      {Boolean(data?.residents.length) && <>
        <div className="residency-table-wrap"><table className="residency-table"><thead><tr><th>Resident</th><th>Room & bed</th><th>Occupancy</th><th>Payment</th><th>Action</th></tr></thead><tbody>{data!.residents.map(resident => <tr key={resident.id}>
          <td><strong>{resident.studentName || "Student"}</strong><span>{resident.studentEmail}</span></td><td><strong>{resident.roomLabel} · {resident.spaceLabel}</strong><span>{resident.propertyName} · {resident.periodName}</span></td>
          <td><span className={`residency-status is-${state(resident).toLowerCase()}`}>{label[state(resident)] || state(resident)}</span>{resident.unreadMessages > 0 && <small>{resident.unreadMessages} unread messages</small>}</td>
          <td><strong>{cedis(resident.totalAmount)}</strong><span>{label[resident.status]}</span></td><td><button type="button" onClick={() => setSelected(resident)}>View resident <ArrowRight size={15} aria-hidden /></button></td>
        </tr>)}</tbody></table></div>
        <div className="residency-mobile-cards">{data!.residents.map(resident => <button type="button" className="residency-person-card" key={resident.id} onClick={() => setSelected(resident)}><div><strong>{resident.studentName || "Student"}</strong><span className={`residency-status is-${state(resident).toLowerCase()}`}>{label[state(resident)]}</span></div><span><Buildings size={16} aria-hidden />{resident.roomLabel} · {resident.spaceLabel}</span><small>{resident.propertyName} · {resident.periodName}</small><footer><span>{cedis(resident.totalAmount)} · {label[resident.status]}</span><ArrowRight size={19} /></footer></button>)}</div>
      </>}
    </div>
    {data && <nav className="residency-pagination" aria-label="Resident pages"><span>{data.pagination.total} results · Page {data.pagination.page} of {data.pagination.pages}</span><div><button type="button" disabled={loading || data.pagination.page <= 1} onClick={() => setFilters(current => ({ ...current, page: data.pagination.page - 1 }))}>Previous</button><button type="button" disabled={loading || data.pagination.page >= data.pagination.pages} onClick={() => setFilters(current => ({ ...current, page: data.pagination.page + 1 }))}>Next</button></div></nav>}
    <ResidencyDialog open={filterOpen} title="Filter residents" onClose={() => setFilterOpen(false)}><div className="residency-form">{filterFields}<button type="button" onClick={() => setFilterOpen(false)}>Show residents</button></div></ResidencyDialog>
    {selected && <ResidentDetail reference={selected.reference} onClose={() => setSelected(null)} onUpdated={load} onMessage={onMessage} />}
  </div>;
}

function ResidentDetail({ reference, onClose, onUpdated, onMessage }: { reference: string; onClose: () => void; onUpdated: () => Promise<void>; onMessage: (resident: { reference: string; name: string }) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<StayAction | "">("");
  const [draft, setDraft] = useState({ expectedArrivalOn: "", keyReference: "", keysReturned: false, note: "", targetListingId: "" });
  const [targetSearch, setTargetSearch] = useState("");
  const load = useCallback(async () => {
    try { setError(""); const result = await read<Detail>("/api/console/hostel/residents/stay?" + new URLSearchParams({ reference })); setDetail(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Resident could not load."); }
  }, [reference]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  function choose(value: StayAction) {
    setError(""); setNotice(""); setAction(value);
    setDraft({ expectedArrivalOn: detail?.booking.expectedArrivalOn || "", keyReference: "", keysReturned: false, note: "", targetListingId: "" });
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!detail || !action) return;
    setBusy(true); setError("");
    try {
      const result = await read<Detail>("/api/console/hostel/residents/stay", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference, action, version: detail.booking.stayVersion, ...draft }) });
      setDetail(result); setNotice(`${label[action]} recorded.`); setAction(""); await onUpdated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That change could not be saved."); }
    finally { setBusy(false); }
  }
  const booking = detail?.booking;
  return <ResidencyDialog open title={booking?.studentName || "Resident details"} onClose={onClose} busy={busy} drawer>
    {error && <p className="residency-alert" role="alert">{error} <button type="button" disabled={busy} onClick={() => { setAction(""); void load(); }}>Refresh details</button></p>}
    {notice && <p className="residency-success" role="status">{notice}</p>}
    {!booking ? <p role="status">Loading resident…</p> : <>
      <div className="residency-detail-hero"><span className={`residency-status is-${state(booking).toLowerCase()}`}>{label[state(booking)]}</span><h3>{booking.roomLabel} <span>· {booking.spaceLabel}</span></h3><p>{booking.propertyName} · {booking.periodName}</p><small>{booking.reference}</small></div>
      <dl className="residency-details"><div><dt>Expected arrival</dt><dd>{date(booking.expectedArrivalOn)}</dd></div><div><dt>Check-in</dt><dd>{date(booking.checkedInAt)}</dd></div><div><dt>Checkout</dt><dd>{date(booking.checkedOutAt)}</dd></div><div><dt>Payment</dt><dd>{cedis(booking.totalAmount)} · {label[booking.status]}</dd></div></dl>
      <div className="residency-contact"><a href={`mailto:${booking.studentEmail}`}>{booking.studentEmail}</a>{booking.studentPhone && <a href={`tel:${booking.studentPhone}`}>{booking.studentPhone}</a>}<button type="button" onClick={() => { onClose(); onMessage({ reference, name: booking.studentName || booking.studentEmail }); }}>Message resident</button></div>
      {booking.status === "PAID" && !action && <div className="residency-detail-actions">
        {booking.stayStatus === "EXPECTED" && <><button type="button" onClick={() => choose("CHECK_IN")}>Check in</button><button type="button" onClick={() => choose("SCHEDULE")}>Set arrival date</button><button type="button" onClick={() => choose("NO_SHOW")}>Record no-show</button></>}
        {booking.stayStatus === "CHECKED_IN" && <button type="button" onClick={() => choose("CHECK_OUT")}>Check out</button>}
        {["EXPECTED", "CHECKED_IN"].includes(booking.stayStatus) && <button type="button" onClick={() => choose("TRANSFER")}>Transfer bed</button>}
      </div>}
      {action && <form className="residency-form residency-confirmation" onSubmit={submit}>
        <h3>Confirm {label[action].toLowerCase()}</h3><p>{action === "CHECK_OUT" || action === "NO_SHOW" ? "This releases the bed for another student. The payment record stays unchanged; refunds require their own approval." : action === "TRANSFER" ? "Choose a free bed in this property and year at the same rent and utilities price. Your existing payment record is preserved." : "The change will be recorded with your staff account."}</p>
        {action === "SCHEDULE" && <label>Expected arrival<input type="date" required min={booking.periodStartsOn} max={booking.periodEndsOn} value={draft.expectedArrivalOn} onChange={event => setDraft({ ...draft, expectedArrivalOn: event.target.value })} /></label>}
        {(action === "CHECK_IN" || (action === "TRANSFER" && booking.stayStatus === "CHECKED_IN")) && <label>{action === "TRANSFER" ? "New key reference (if issued)" : "Key reference (if issued)"}<input maxLength={80} placeholder="e.g. A12 key 2" value={draft.keyReference} onChange={event => setDraft({ ...draft, keyReference: event.target.value })} /></label>}
        {(action === "CHECK_OUT" || action === "TRANSFER") && detail?.stay.key_reference && <label className="residency-check"><input type="checkbox" required checked={draft.keysReturned} onChange={event => setDraft({ ...draft, keysReturned: event.target.checked })} />Key {detail.stay.key_reference} has been returned</label>}
        {action === "TRANSFER" && <><label>Find a destination room<input maxLength={80} value={targetSearch} onChange={event => setTargetSearch(event.target.value)} placeholder="Room number or bed label" /></label><button type="button" disabled={busy} onClick={async () => { setBusy(true); try { setDetail(await read<Detail>("/api/console/hostel/residents/stay?" + new URLSearchParams({ reference, q: targetSearch }))); } catch (cause) { setError(cause instanceof Error ? cause.message : "Beds could not load."); } finally { setBusy(false); } }}>Find beds</button><label>Destination bed<select required value={draft.targetListingId} onChange={event => setDraft({ ...draft, targetListingId: event.target.value })}><option value="">Choose an available bed</option>{detail?.destinations.map(target => <option key={target.listing_id} value={target.listing_id}>{target.room_label} · {target.space_label}</option>)}</select></label>{!detail?.destinations.length && <p>No matching free beds. Try another room search.</p>}</>}
        <label>Staff note{["CHECK_OUT", "NO_SHOW", "TRANSFER"].includes(action) ? " (required)" : " (optional)"}<textarea required={["CHECK_OUT", "NO_SHOW", "TRANSFER"].includes(action)} rows={3} maxLength={500} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} /></label>
        <footer><button type="button" disabled={busy} onClick={() => setAction("")}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Saving…" : "Confirm change"}</button></footer>
      </form>}
      <details className="residency-history"><summary>Residency activity · {detail?.events.length || 0}</summary>{detail?.events.length ? <ol>{detail.events.map(event => { let info: { note?: string; from?: string; to?: string } = {}; try { info = JSON.parse(event.details); } catch { /* Older audit entries may have no detail. */ } return <li key={event.id}><strong>{label[event.action] || event.action}</strong>{info.from && <span>{info.from} → {info.to}</span>}{info.note && <p>{info.note}</p>}<small>{event.actor} · {date(event.created_at)}</small></li>; })}</ol> : <p>No occupancy changes recorded yet.</p>}</details>
    </>}
  </ResidencyDialog>;
}
