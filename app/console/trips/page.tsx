"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, BusFront, DoorOpen, LogOut, Megaphone, PencilLine, Plus, Send, Store, Trash2 } from "lucide-react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import type { FlyerPromo } from "@/lib/trip-notice";

type Trip = {
  id: string; title: string; from: string; to: string; travelDate: string;
  departureTime: string; arrivalTime: string; price: number; capacity: number;
  coachType: string; tag: string; amenities: string[]; notes: string;
  reviewStatus: string; reviewReason: string;
  bookingCount: number; confirmedCount: number;
};

type Passenger = { reference: string; name: string; seat: number; phone: string; bookingStatus: string };

type TripOverlap = {
  id: string; title: string; organizerName: string; own: boolean;
  travelDate: string; departureTime: string;
};

type TripDraft = {
  title: string; from: string; to: string; travelDate: string; departureTime: string;
  arrivalTime: string; price: string; capacity: string; coachType: string; tag: string;
  amenities: string; notes: string;
};

const EMPTY_DRAFT: TripDraft = {
  title: "", from: "UMaT Main Campus", to: "Accra", travelDate: "", departureTime: "06:30",
  arrivalTime: "11:30", price: "180", capacity: "50", coachType: "VIP Coach", tag: "",
  amenities: "AC, Wi-Fi, USB power", notes: "",
};

const EDITABLE = new Set(["DRAFT", "REJECTED", "PENDING_REVIEW"]);
const SUBMITTABLE = new Set(["DRAFT", "REJECTED", "SUSPENDED"]);

const NOTICE_FIELDS = [
  { key: "title", label: "Notice title" },
  { key: "route", label: "Route" },
  { key: "fare", label: "Fare" },
  { key: "nightBus", label: "Night bus" },
] as const;

const NOTICE_LISTS = [
  { key: "dayBuses", label: "Day buses (comma separated)" },
  { key: "dropOffPoints", label: "Drop-off points" },
  { key: "amenities", label: "Amenities" },
  { key: "contacts", label: "Contacts" },
] as const;

export default function OrganizerTripsPage() {
  return <ConsoleSessionGate label="your trips">
    {(session) => session.account.role === "ORGANIZER"
      ? <OrganizerWorkspace />
      : <main className="console-page"><section className="console-hero"><h1>Not available</h1><span>This workspace belongs to an organizer account.</span></section></main>}
  </ConsoleSessionGate>;
}

function OrganizerWorkspace() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [notice, setNotice] = useState<FlyerPromo | null>(null);
  const [manifest, setManifest] = useState<{ trip: Trip; passengers: Passenger[] } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TripDraft | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [overlaps, setOverlaps] = useState<TripOverlap[]>([]);
  const [busy, setBusy] = useState("");

  const loadTrips = useCallback(async () => {
    try {
      const response = await fetch("/api/console/trips", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your trips could not be loaded.");
      setTrips(data.trips || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your trips could not be loaded.");
    }
  }, []);

  const loadNotice = useCallback(async () => {
    try {
      const response = await fetch("/api/console/trips/notice", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (response.ok) setNotice(data.notice);
    } catch {
      // The trips list already reports a connection problem; the notice form
      // stays hidden rather than showing a second copy of the same error.
    }
  }, []);

  useEffect(() => {
    queueMicrotask(loadTrips);
    queueMicrotask(loadNotice);
  }, [loadTrips, loadNotice]);

  function startCreate() {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    setError(""); setSaved("");
  }

  function startEdit(trip: Trip) {
    setEditingId(trip.id);
    setDraft({
      title: trip.title, from: trip.from, to: trip.to, travelDate: trip.travelDate,
      departureTime: trip.departureTime, arrivalTime: trip.arrivalTime, price: String(trip.price),
      capacity: String(trip.capacity), coachType: trip.coachType, tag: trip.tag,
      amenities: trip.amenities.join(", "), notes: trip.notes,
    });
    setError(""); setSaved("");
  }

  async function saveTrip(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save"); setError(""); setSaved("");
    try {
      const payload = {
        ...draft,
        price: Number(draft.price),
        capacity: Number(draft.capacity),
        amenities: draft.amenities.split(",").map((item) => item.trim()).filter(Boolean),
      };
      const response = await fetch(editingId ? `/api/console/trips/${encodeURIComponent(editingId)}` : "/api/console/trips", {
        method: editingId ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The trip could not be saved.");
      setSaved(editingId
        ? "Trip saved. A live trip goes back for review before it is bookable again."
        : "Trip saved as a draft. Submit it for review when it is ready.");
      // Reported, never a refusal: the trip is already saved. An organizer who
      // knows they are the second coach on a route can price or time around it.
      setOverlaps((data.trip?.overlaps || []) as TripOverlap[]);
      setDraft(null);
      setEditingId(null);
      await loadTrips();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The trip could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function decide(trip: Trip, action: "SUBMIT" | "REMOVE") {
    setBusy(trip.id); setError(""); setSaved("");
    try {
      const response = action === "SUBMIT"
        ? await fetch(`/api/console/trips/${encodeURIComponent(trip.id)}/review`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "SUBMIT" }),
        })
        : await fetch(`/api/console/trips/${encodeURIComponent(trip.id)}`, { method: "DELETE", credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That action could not be completed.");
      setSaved(action === "SUBMIT" ? "Sent for review. You will see the decision here." : "Trip removed.");
      await loadTrips();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That action could not be completed.");
    } finally {
      setBusy("");
    }
  }

  async function openManifest(trip: Trip) {
    setError("");
    try {
      const response = await fetch(`/api/console/trips/${encodeURIComponent(trip.id)}/manifest`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The manifest could not be loaded.");
      setManifest({ trip, passengers: data.passengers || [] });
    } catch (manifestError) {
      setError(manifestError instanceof Error ? manifestError.message : "The manifest could not be loaded.");
    }
  }

  async function saveNotice(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!notice) return;
    setBusy("notice"); setError(""); setSaved("");
    try {
      const response = await fetch("/api/console/trips/notice", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(notice),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The notice could not be saved.");
      setNotice(data.notice);
      setSaved("Notice saved. It now shows on your own trips.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The notice could not be saved.");
    } finally {
      setBusy("");
    }
  }

  const fieldValue = (key: string) => {
    const value = notice ? (notice as unknown as Record<string, unknown>)[key] : undefined;
    if (Array.isArray(value)) return value.join(", ");
    return typeof value === "string" ? value : "";
  };
  const setField = (key: string, raw: string) => setNotice((current) => current
    ? { ...current, [key]: raw.split(",").map((item) => item.trim()).filter(Boolean) }
    : current);

  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><Store size={15}/>Organizer</span>
        <Link href="/console/profile">Business profile</Link>
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>YOUR TRIPS</p>
      <h1>Coaches you organise</h1>
      <span>A trip becomes bookable only after a reviewer approves it. Editing a live trip sends it back for review.</span>
    </section>

    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}
    {overlaps.length > 0 && <div className="console-alert" role="status">
      <AlertTriangle size={15}/> {overlaps.length === 1 ? "Another departure is" : `${overlaps.length} other departures are`} already scheduled on this route around the same time:
      {" "}{overlaps.slice(0, 3).map((overlap) => `${overlap.own ? "your" : overlap.organizerName || "another organizer's"} ${overlap.departureTime}${overlap.title ? ` (${overlap.title})` : ""}`).join(", ")}
      {overlaps.length > 3 ? `, and ${overlaps.length - 3} more` : ""}.
      {" "}That is allowed — two coaches on one route is a real service — but it splits the same passengers.
    </div>}

    <section className="console-panel">
      <h2><BusFront size={18}/>Trips
        <button className="console-panel-close" onClick={startCreate}><Plus size={14}/>Publish a trip</button>
      </h2>
      {trips.length === 0
        ? <p className="console-empty">No trips yet. Publish one and submit it for review.</p>
        : <table className="console-table">
          <thead><tr><th>Trip</th><th>Departs</th><th>Fare</th><th>Seats sold</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {trips.map((trip) => (
              <tr key={trip.id}>
                <td><strong>{trip.from} → {trip.to}</strong><small>{trip.title}</small></td>
                <td><span>{trip.travelDate}</span><small>{trip.departureTime} – {trip.arrivalTime}</small></td>
                <td>GHS {trip.price}</td>
                <td><span>{trip.confirmedCount} confirmed</span><small>{trip.bookingCount} total of {trip.capacity}</small></td>
                <td>
                  <span className={`console-badge console-badge-${trip.reviewStatus.toLowerCase()}`}>{trip.reviewStatus.replace("_", " ")}</span>
                  {trip.reviewReason && <small className="console-reason">{trip.reviewReason}</small>}
                </td>
                <td className="console-row-actions">
                  {EDITABLE.has(trip.reviewStatus) && <button disabled={busy === trip.id} onClick={() => startEdit(trip)}><PencilLine size={15}/>Edit</button>}
                  {SUBMITTABLE.has(trip.reviewStatus) && <button disabled={busy === trip.id} onClick={() => decide(trip, "SUBMIT")}><Send size={15}/>Submit</button>}
                  {trip.reviewStatus !== "APPROVED" && <button disabled={busy === trip.id} onClick={() => decide(trip, "REMOVE")}><Trash2 size={15}/>Remove</button>}
                  <button onClick={() => openManifest(trip)}><DoorOpen size={15}/>Manifest</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

    {draft && <section className="console-panel">
      <h2><PencilLine size={18}/>{editingId ? "Edit trip" : "New trip"}</h2>
      <form className="console-form" onSubmit={saveTrip}>
        <label className="console-field-wide">Title
          <input type="text" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="UMaT → Accra" />
        </label>
        <label>From<input type="text" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>To<input type="text" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <label>Travel date<input type="date" required value={draft.travelDate} onChange={(event) => setDraft({ ...draft, travelDate: event.target.value })} /></label>
        <label>Departure<input type="time" required value={draft.departureTime} onChange={(event) => setDraft({ ...draft, departureTime: event.target.value })} /></label>
        <label>Arrival<input type="time" required value={draft.arrivalTime} onChange={(event) => setDraft({ ...draft, arrivalTime: event.target.value })} /></label>
        <label>Fare (GHS)<input type="number" min="1" required value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} /></label>
        <label>Seats<input type="number" min="1" max="80" required value={draft.capacity} onChange={(event) => setDraft({ ...draft, capacity: event.target.value })} /></label>
        <label>Coach type<input type="text" value={draft.coachType} onChange={(event) => setDraft({ ...draft, coachType: event.target.value })} /></label>
        <label>Tag<input type="text" value={draft.tag} onChange={(event) => setDraft({ ...draft, tag: event.target.value })} placeholder="Morning Express" /></label>
        <label className="console-field-wide">Amenities (comma separated)<input type="text" value={draft.amenities} onChange={(event) => setDraft({ ...draft, amenities: event.target.value })} /></label>
        <label className="console-field-wide">Notes<textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
        <button disabled={busy === "save"}><Send size={16}/>{busy === "save" ? "Saving…" : editingId ? "Save trip" : "Create draft"}</button>
        <button type="button" className="console-secondary" onClick={() => { setDraft(null); setEditingId(null); }}>Cancel</button>
      </form>
    </section>}

    {manifest && <section className="console-panel">
      <h2><DoorOpen size={18}/>Manifest · {manifest.trip.from} → {manifest.trip.to} · {manifest.trip.travelDate}
        <button className="console-panel-close" onClick={() => setManifest(null)}>Close</button>
      </h2>
      {manifest.passengers.length === 0
        ? <p className="console-empty">No bookings on this trip yet.</p>
        : <table className="console-table">
          <thead><tr><th>Seat</th><th>Passenger</th><th>Phone</th><th>Reference</th><th>Status</th></tr></thead>
          <tbody>
            {manifest.passengers.map((passenger) => (
              <tr key={passenger.reference}>
                <td>{passenger.seat}</td>
                <td>{passenger.name}</td>
                <td><a href={`tel:${passenger.phone}`}>{passenger.phone}</a></td>
                <td>{passenger.reference}</td>
                <td><span className="console-badge">{passenger.bookingStatus}</span></td>
              </tr>
            ))}
          </tbody>
        </table>}
      <p className="console-note">Passenger numbers come from the student account that booked the seat and are shown for this trip only. Every view is audited.</p>
    </section>}

    {notice && <section className="console-panel">
      <h2><Megaphone size={18}/>Trip notice</h2>
      <form className="console-form" onSubmit={saveNotice}>
        <label className="console-check-field">
          <input type="checkbox" checked={notice.enabled} onChange={(event) => setNotice({ ...notice, enabled: event.target.checked })} />
          Show this notice on my trips
        </label>
        {NOTICE_FIELDS.map((field) => (
          <label key={field.key}>{field.label}
            <input type="text" value={fieldValue(field.key)} onChange={(event) => setNotice({ ...notice, [field.key]: event.target.value })} />
          </label>
        ))}
        {NOTICE_LISTS.map((field) => (
          <label key={field.key}>{field.label}
            <input type="text" value={fieldValue(field.key)} onChange={(event) => setField(field.key, event.target.value)} />
          </label>
        ))}
        <button disabled={busy === "notice"}><Megaphone size={16}/>{busy === "notice" ? "Saving…" : "Save notice"}</button>
      </form>
      <p className="console-note">Trips with no organizer notice keep the platform notice, so nothing disappears from the public page.</p>
    </section>}
  </main>;
}
