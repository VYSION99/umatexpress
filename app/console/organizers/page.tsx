"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BusFront, Check, Clock, LogOut, ShieldCheck, UserX } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";

type Organizer = {
  id: string; name: string; email: string; phone: string; organization: string;
  status: string; kycStatus: string; createdAt: string; accountStatus: string;
};

type AdminTrip = {
  id: string; title: string; from: string; to: string; travelDate: string; organizerId: string;
};

const FILTERS = ["PENDING", "APPROVED", "SUSPENDED", ""] as const;
const FILTER_LABEL: Record<string, string> = { PENDING: "Waiting", APPROVED: "Approved", SUSPENDED: "Suspended", "": "All" };

export default function ConsoleOrganizersPage() {
  return <ConsoleSessionGate label="organizer applications">
    {(session) => session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ApplicationQueue session={session} />
      : <main className="console-page"><section className="console-hero"><h1>Not available</h1><span>Your console role does not review organizer applications.</span></section></main>}
  </ConsoleSessionGate>;
}

function ApplicationQueue({ session }: { session: ConsoleSessionInfo }) {
  const [organizers, setOrganizers] = useState<Organizer[]>([]);
  const [filter, setFilter] = useState<string>("PENDING");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (status: string) => {
    setError("");
    try {
      const response = await fetch(`/api/console/organizers?status=${encodeURIComponent(status)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Applications could not be loaded.");
      setOrganizers(data.organizers || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Applications could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(() => load(filter)); }, [filter, load]);

  async function decide(organizer: Organizer, action: "APPROVE" | "REJECT" | "SUSPEND") {
    let reason = "";
    if (action === "REJECT" || action === "SUSPEND") {
      reason = window.prompt(action === "REJECT" ? "Why is this application rejected?" : "Why is this organizer suspended?")?.trim() || "";
      if (!reason) return;
    }
    setBusy(organizer.id);
    setError("");
    try {
      const response = await fetch("/api/console/organizers", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizerId: organizer.id, action, reason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The decision could not be saved.");
      setNotice(`${organizer.name} · ${action.toLowerCase()}d`);
      await load(filter);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The decision could not be saved.");
    } finally {
      setBusy("");
    }
  }

  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><ShieldCheck size={15}/>{session.account.role === "ADMIN" ? "Administrator" : "Moderator"}</span>
        <span className="console-account-email">{session.account.email}</span>
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>TRIP ORGANIZERS</p>
      <h1>Applications</h1>
      <span>Approve an organizer to activate their account. Nobody can publish a trip until this decision is made.</span>
    </section>

    <section className="console-panel">
      <div className="console-toolbar">
        {FILTERS.map((option) => (
          <button key={option || "all"} className={filter === option ? "is-active" : ""} onClick={() => setFilter(option)}>
            {FILTER_LABEL[option]}
          </button>
        ))}
      </div>

      {error && <div className="console-alert" role="alert">{error}</div>}
      {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

      {organizers.length === 0
        ? <p className="console-empty">{error ? "" : `No ${FILTER_LABEL[filter].toLowerCase()} applications.`}</p>
        : <table className="console-table">
          <thead><tr><th>Organizer</th><th>Contact</th><th>Applied</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {organizers.map((organizer) => (
              <tr key={organizer.id}>
                <td><strong>{organizer.organization || organizer.name}</strong><small>{organizer.organization ? organizer.name : ""}</small></td>
                <td><span>{organizer.email}</span><small>{organizer.phone}</small></td>
                <td>{organizer.createdAt.slice(0, 10)}</td>
                <td><span className={`console-badge console-badge-${organizer.status.toLowerCase()}`}>{organizer.status}</span></td>
                <td className="console-row-actions">
                  {organizer.status === "PENDING" && <>
                    <button disabled={busy === organizer.id} onClick={() => decide(organizer, "APPROVE")}><Check size={15}/>Approve</button>
                    <button disabled={busy === organizer.id} onClick={() => decide(organizer, "REJECT")}><UserX size={15}/>Reject</button>
                  </>}
                  {organizer.status === "APPROVED" && <button disabled={busy === organizer.id} onClick={() => decide(organizer, "SUSPEND")}><UserX size={15}/>Suspend</button>}
                  {organizer.status === "SUSPENDED" && <button disabled={busy === organizer.id} onClick={() => decide(organizer, "APPROVE")}><Check size={15}/>Reinstate</button>}
                  {organizer.status === "REJECTED" && <button disabled={busy === organizer.id} onClick={() => decide(organizer, "APPROVE")}><Clock size={15}/>Approve anyway</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

    {session.account.role === "ADMIN" && <AssignmentPanel organizers={organizers} />}
  </main>;
}

/**
 * Phase 2 has no organizer-created trips, so ownership is established here:
 * an admin hands an existing trip to an approved organizer. Before approval an
 * organizer cannot be given a trip, which is what keeps a pending applicant
 * from becoming bookable.
 */
function AssignmentPanel({ organizers }: { organizers: Organizer[] }) {
  const [trips, setTrips] = useState<AdminTrip[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const approved = organizers.filter((organizer) => organizer.status === "APPROVED");

  const loadTrips = useCallback(async () => {
    try {
      const response = await fetch("/api/trips/schedule?admin=1", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Trips could not be loaded.");
      setTrips(data.trips || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Trips could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(loadTrips); }, [loadTrips]);

  async function assign(trip: AdminTrip, organizerId: string) {
    setBusy(trip.id);
    setError("");
    try {
      const response = await fetch("/api/console/trips", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tripId: trip.id, organizerId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The trip could not be assigned.");
      await loadTrips();
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "The trip could not be assigned.");
    } finally {
      setBusy("");
    }
  }

  return <section className="console-panel">
    <h2><BusFront size={18}/>Trip ownership</h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {trips.length === 0
      ? <p className="console-empty">{error ? "" : "No trips to assign."}</p>
      : <table className="console-table">
        <thead><tr><th>Trip</th><th>Departs</th><th>Owner</th></tr></thead>
        <tbody>
          {trips.map((trip) => (
            <AssignmentRow
              key={trip.id}
              trip={trip}
              approved={approved}
              busy={busy === trip.id}
              onAssign={(organizerId) => assign(trip, organizerId)}
            />
          ))}
        </tbody>
      </table>}
    <p className="console-note">Only approved organizers can be given a trip. Leaving a trip on the platform keeps it publicly bookable as before.</p>
  </section>;
}

function AssignmentRow({ trip, approved, busy, onAssign }: {
  trip: AdminTrip;
  approved: Organizer[];
  busy: boolean;
  onAssign: (organizerId: string) => void;
}) {
  const [selected, setSelected] = useState(trip.organizerId);
  return <tr>
    <td><strong>{trip.from} → {trip.to}</strong><small>{trip.title}</small></td>
    <td>{trip.travelDate}</td>
    <td className="console-row-actions">
      <select value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">Platform</option>
        {approved.map((organizer) => (
          <option key={organizer.id} value={organizer.id}>{organizer.organization || organizer.name}</option>
        ))}
      </select>
      <button disabled={busy || selected === trip.organizerId} onClick={() => onAssign(selected)}>
        {busy ? "Saving…" : "Assign"}
      </button>
    </td>
  </tr>;
}
