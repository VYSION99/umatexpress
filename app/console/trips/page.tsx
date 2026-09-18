"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BusFront, DoorOpen, LogOut, Megaphone, Store } from "lucide-react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import type { FlyerPromo } from "@/lib/trip-notice";

type Trip = {
  id: string; title: string; from: string; to: string; travelDate: string;
  departureTime: string; arrivalTime: string; price: number; capacity: number;
  coachType: string; reviewStatus: string; bookingCount: number; confirmedCount: number;
};

type Passenger = { reference: string; name: string; seat: number; phone: string; bookingStatus: string };

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
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

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
    setBusy(true); setError(""); setSaved("");
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
      setBusy(false);
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
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>YOUR TRIPS</p>
      <h1>Coaches you organise</h1>
      <span>Only your own trips appear here. Opening a manifest records the read in the platform audit log.</span>
    </section>

    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <section className="console-panel">
      <h2><BusFront size={18}/>Bookings</h2>
      {trips.length === 0
        ? <p className="console-empty">No trips are assigned to you yet. An administrator assigns them until self-service publishing arrives.</p>
        : <table className="console-table">
          <thead><tr><th>Trip</th><th>Departs</th><th>Fare</th><th>Seats sold</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {trips.map((trip) => (
              <tr key={trip.id}>
                <td><strong>{trip.from} → {trip.to}</strong><small>{trip.title}</small></td>
                <td><span>{trip.travelDate}</span><small>{trip.departureTime} – {trip.arrivalTime}</small></td>
                <td>GHS {trip.price}</td>
                <td><span>{trip.confirmedCount} confirmed</span><small>{trip.bookingCount} total of {trip.capacity}</small></td>
                <td><span className={`console-badge console-badge-${trip.reviewStatus.toLowerCase()}`}>{trip.reviewStatus}</span></td>
                <td className="console-row-actions"><button onClick={() => openManifest(trip)}><DoorOpen size={15}/>Manifest</button></td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

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
        <button disabled={busy}><Megaphone size={16}/>{busy ? "Saving…" : "Save notice"}</button>
      </form>
      <p className="console-note">Trips with no organizer notice keep the platform notice, so nothing disappears from the public page.</p>
    </section>}
  </main>;
}
