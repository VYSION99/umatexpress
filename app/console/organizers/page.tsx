"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, BusFront, Check, Clock, Eye, UserX } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";

type Organizer = {
  id: string; name: string; email: string; phone: string; organization: string;
  status: string; kycStatus: string; createdAt: string; accountStatus: string;
};

type AdminTrip = {
  id: string; title: string; from: string; to: string; travelDate: string; organizerId: string;
};

type ReviewTrip = {
  id: string; title: string; from: string; to: string; travelDate: string; departureTime: string;
  arrivalTime: string; price: number; capacity: number; organizerId: string; organizerName: string;
  platformOwned: boolean; submittedAt: string;
};

const FILTERS = ["PENDING", "APPROVED", "SUSPENDED", ""] as const;
const FILTER_LABEL: Record<string, string> = { PENDING: "Waiting", APPROVED: "Approved", SUSPENDED: "Suspended", "": "All" };

export default function ConsoleOrganizersPage() {
  return <ConsoleSessionGate label="organizer applications">
    {(session) => session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ApplicationQueue session={session} />
      : <ConsoleShell session={session} service="organizers" label="TRIP ORGANIZERS" title="Not available" blurb="Your console role does not review organizer applications.">{null}</ConsoleShell>}
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

  /**
   * KYC is the money gate, decided separately from the account gate: verifying
   * it never changes whether the organizer can sign in.
   */
  async function decideKyc(organizer: Organizer, action: "VERIFY_KYC" | "REJECT_KYC") {
    let reason = "";
    if (action === "REJECT_KYC") {
      reason = window.prompt("Why is this KYC rejected?")?.trim() || "";
      if (!reason) return;
    }
    setBusy(organizer.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/organizers", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizerId: organizer.id, action, reason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The KYC decision could not be saved.");
      setNotice(`${organizer.name} · KYC ${data.organizer?.kycStatus || "updated"}`);
      await load(filter);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The KYC decision could not be saved.");
    } finally {
      setBusy("");
    }
  }

  /** Reading a full account number is an audited event, never a silent one. */
  async function reveal(organizer: Organizer) {
    setBusy(organizer.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/organizers/reveal", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizerId: organizer.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Those details could not be revealed.");
      const revealed = data.revealed || {};
      const lines = [
        revealed.payoutAccountNumber ? `Payout account: ${revealed.payoutAccountNumber}` : "",
        revealed.kycIdNumber ? `ID number: ${revealed.kycIdNumber}` : "",
      ].filter(Boolean);
      window.alert(lines.length ? `${lines.join("\n")}\n\nThis reveal is recorded in the audit log.` : "Nothing has been saved to reveal yet.");
      setNotice(`${organizer.name} · details revealed (audited)`);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : "Those details could not be revealed.");
    } finally {
      setBusy("");
    }
  }

  return <ConsoleShell
    session={session}
    service="organizers"
    label="TRIP ORGANIZERS"
    title="Applications"
    blurb="Approve an organizer to activate their account. Nobody can publish a trip until this decision is made."
  >

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
          <thead><tr><th>Organizer</th><th>Contact</th><th>Applied</th><th>Status</th><th>KYC</th><th></th></tr></thead>
          <tbody>
            {organizers.map((organizer) => (
              <tr key={organizer.id}>
                <td><strong>{organizer.organization || organizer.name}</strong><small>{organizer.organization ? organizer.name : ""}</small></td>
                <td><span>{organizer.email}</span><small>{organizer.phone}</small></td>
                <td>{organizer.createdAt.slice(0, 10)}</td>
                <td><span className={`console-badge console-badge-${organizer.status.toLowerCase()}`}>{organizer.status}</span></td>
                <td><span className={`console-badge console-badge-${organizer.kycStatus.toLowerCase()}`}>{organizer.kycStatus}</span></td>
                <td className="console-row-actions">
                  {organizer.status === "PENDING" && <>
                    <button disabled={busy === organizer.id} onClick={() => decide(organizer, "APPROVE")}><Check size={15}/>Approve</button>
                    <button disabled={busy === organizer.id} onClick={() => decide(organizer, "REJECT")}><UserX size={15}/>Reject</button>
                  </>}
                  {organizer.status === "APPROVED" && <button disabled={busy === organizer.id} onClick={() => decide(organizer, "SUSPEND")}><UserX size={15}/>Suspend</button>}
                  {organizer.status === "SUSPENDED" && <button disabled={busy === organizer.id} onClick={() => decide(organizer, "APPROVE")}><Check size={15}/>Reinstate</button>}
                  {organizer.status === "REJECTED" && <button disabled={busy === organizer.id} onClick={() => decide(organizer, "APPROVE")}><Clock size={15}/>Approve anyway</button>}
                  {organizer.status === "APPROVED" && organizer.kycStatus === "PENDING" && <>
                    <button disabled={busy === organizer.id} onClick={() => decideKyc(organizer, "VERIFY_KYC")}><BadgeCheck size={15}/>Verify KYC</button>
                    <button disabled={busy === organizer.id} onClick={() => decideKyc(organizer, "REJECT_KYC")}><UserX size={15}/>Reject KYC</button>
                  </>}
                  {session.account.role === "ADMIN" && organizer.status === "APPROVED" &&
                    <button disabled={busy === organizer.id} onClick={() => reveal(organizer)}><Eye size={15}/>Reveal</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

    {session.account.role === "ADMIN" && <AssignmentPanel organizers={organizers} />}
    <TripReviewPanel />
  </ConsoleShell>;
}

/**
 * Trips waiting on a decision. Approval is what makes a trip bookable, so this
 * queue — not the database — is the point where an organizer's work reaches
 * students.
 */
function TripReviewPanel() {
  const [trips, setTrips] = useState<ReviewTrip[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const loadTrips = useCallback(async () => {
    try {
      const response = await fetch("/api/console/trips/review", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The review queue could not be loaded.");
      setTrips(data.trips || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The review queue could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(loadTrips); }, [loadTrips]);

  async function decide(trip: ReviewTrip, action: "APPROVE" | "REJECT") {
    let reason = "";
    if (action === "REJECT") {
      reason = window.prompt("Why is this trip rejected?")?.trim() || "";
      if (!reason) return;
    }
    setBusy(trip.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/console/trips/${encodeURIComponent(trip.id)}/review`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The decision could not be saved.");
      setNotice(`${trip.from} → ${trip.to} · ${action === "APPROVE" ? "approved and live" : "sent back"}`);
      await loadTrips();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The decision could not be saved.");
    } finally {
      setBusy("");
    }
  }

  return <section className="console-panel">
    <h2><BusFront size={18}/>Trips awaiting review</h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    {trips.length === 0
      ? <p className="console-empty">{error ? "" : "Nothing is waiting for a decision."}</p>
      : <table className="console-table">
        <thead><tr><th>Trip</th><th>Organizer</th><th>Departs</th><th>Fare</th><th></th></tr></thead>
        <tbody>
          {trips.map((trip) => (
            <tr key={trip.id}>
              <td><strong>{trip.from} → {trip.to}</strong><small>{trip.title}</small></td>
              <td>{trip.platformOwned ? <span className="console-badge">Platform</span> : (trip.organizerName || "Organizer")}</td>
              <td><span>{trip.travelDate}</span><small>{trip.departureTime} – {trip.arrivalTime} · {trip.capacity} seats</small></td>
              <td>GHS {trip.price}</td>
              <td className="console-row-actions">
                <button disabled={busy === trip.id} onClick={() => decide(trip, "APPROVE")}><Check size={15}/>Approve</button>
                <button disabled={busy === trip.id} onClick={() => decide(trip, "REJECT")}><UserX size={15}/>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>}
    <p className="console-note">Approving a trip makes it bookable immediately. Rejecting sends it back with your reason.</p>
  </section>;
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
