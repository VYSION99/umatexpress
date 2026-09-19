"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Gavel, LogOut, MessageSquareWarning, Scale, Store } from "lucide-react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";

type Dispute = {
  id: string; organizerId: string; organizerName: string; tripId: string; bookingReference: string;
  raisedByRole: string; raisedBy: string; category: string; subject: string; details: string;
  status: string; resolution: string; resolutionNote: string; resolvedBy: string; resolvedAt: string;
  createdAt: string;
};

const CATEGORIES = [
  { value: "BOOKING", label: "Booking problem" },
  { value: "REFUND", label: "Refund" },
  { value: "TRIP_CANCELLED", label: "Trip cancelled" },
  { value: "DELAY", label: "Delay or no-show" },
  { value: "CONDUCT", label: "Conduct" },
  { value: "PAYMENT", label: "Payment" },
  { value: "OTHER", label: "Something else" },
] as const;

const RESOLUTIONS = [
  { value: "REFUND", label: "Refund the passenger" },
  { value: "PARTIAL_REFUND", label: "Partly refund" },
  { value: "RELEASE_PAYOUT", label: "Release the payout" },
  { value: "NO_ACTION", label: "No action" },
  { value: "OTHER", label: "Other" },
] as const;

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function DisputesConsolePage() {
  return <ConsoleSessionGate label="disputes">
    {(session) => session.account.role === "ORGANIZER"
      ? <OrganizerDisputes />
      : <TriageWorkspace readOnly={session.account.role !== "ADMIN"} />}
  </ConsoleSessionGate>;
}

function TriageWorkspace({ readOnly }: { readOnly: boolean }) {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Dispute | null>(null);
  const [form, setForm] = useState({ status: "RESOLVED", resolution: "NO_ACTION", note: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async (status: string) => {
    try {
      const response = await fetch(`/api/console/disputes${status ? `?status=${status}` : ""}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Disputes could not be loaded.");
      setDisputes(data.disputes || []);
      setCounts(data.counts || {});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Disputes could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(() => load(filter)); }, [load, filter]);

  const open = useMemo(() => (counts.OPEN || 0) + (counts.REVIEWING || 0), [counts]);

  const resolve = useCallback(async () => {
    if (!selected) return;
    setBusy("resolve"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/disputes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "RESOLVE", disputeId: selected.id, ...form }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That decision could not be recorded.");
      setNotice(`${selected.subject} marked ${data.dispute.status}${form.status === "RESOLVED" ? ` · ${form.resolution.replace(/_/g, " ").toLowerCase()}` : ""}.`);
      setForm({ status: "RESOLVED", resolution: "NO_ACTION", note: "" });
      setSelected(null);
      await load(filter);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "That decision could not be recorded.");
    } finally {
      setBusy("");
    }
  }, [selected, form, filter, load]);

  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><Scale size={15}/>{readOnly ? "Moderator" : "Administrator"}</span>
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>DISPUTES</p>
      <h1>What passengers and organizers have raised</h1>
      <span>
        A decision is recorded here, with who made it and why. Moving the money it implies — cancelling a booking, reversing a payout — stays a separate, audited action.
      </span>
    </section>

    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    <section className="console-totals">
      <article><span>Open</span><strong>{counts.OPEN || 0}</strong><small>not yet looked at</small></article>
      <article><span>In review</span><strong>{counts.REVIEWING || 0}</strong><small>being looked into</small></article>
      <article><span>Resolved</span><strong>{counts.RESOLVED || 0}</strong><small>decided</small></article>
      <article><span>Needing attention</span><strong>{open}</strong><small>open plus in review</small></article>
    </section>

    <section className="console-panel">
      <h2><MessageSquareWarning size={18}/>Queue
        <span className="console-row-actions">
          {["", "OPEN", "REVIEWING", "RESOLVED"].map((status) => (
            <button key={status || "ALL"} className="console-panel-close" aria-pressed={filter === status} onClick={() => { setFilter(status); setSelected(null); }}>
              {status || "All"}
            </button>
          ))}
        </span>
      </h2>
      {disputes.length === 0
        ? <p className="console-empty">Nothing here. A dispute filed by a passenger or an organizer appears in this list.</p>
        : <table className="console-table">
          <thead><tr><th>Raised</th><th>About</th><th>From</th><th>Category</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {disputes.map((dispute) => (
              <tr key={dispute.id}>
                <td><span>{when(dispute.createdAt)}</span><small>{dispute.raisedByRole.toLowerCase()}</small></td>
                <td>
                  <span>{dispute.subject}</span>
                  <small>{dispute.organizerName || dispute.organizerId}{dispute.bookingReference ? ` · ${dispute.bookingReference}` : ""}</small>
                </td>
                <td>{dispute.raisedBy}</td>
                <td>{dispute.category.replace(/_/g, " ").toLowerCase()}</td>
                <td>
                  <span className={`console-badge console-badge-${dispute.status.toLowerCase()}`}>{dispute.status}</span>
                  {dispute.resolution && <small>{dispute.resolution.replace(/_/g, " ").toLowerCase()}</small>}
                </td>
                <td className="console-row-actions">
                  <button onClick={() => { setSelected(dispute); setError(""); setNotice(""); }}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>

    {selected && <section className="console-panel">
      <h2><Gavel size={18}/>{selected.subject}
        <button className="console-panel-close" onClick={() => setSelected(null)}>Close</button>
      </h2>
      <p className="console-note">
        {selected.raisedByRole.toLowerCase()} {selected.raisedBy} · {when(selected.createdAt)} · {selected.category.replace(/_/g, " ").toLowerCase()}
        {selected.bookingReference ? ` · booking ${selected.bookingReference}` : ""}
      </p>
      <p>{selected.details}</p>
      {selected.resolutionNote && <p className="console-note">
        Decided by {selected.resolvedBy}: {selected.resolutionNote}
      </p>}

      {readOnly
        ? <p className="console-note">A moderator can read the queue; recording a decision is an administrator action.</p>
        : <form className="console-form" onSubmit={(event) => { event.preventDefault(); void resolve(); }}>
          <label>Decision
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="REVIEWING">Take it in hand</option>
              <option value="RESOLVED">Resolved</option>
              <option value="DISMISSED">Dismissed</option>
            </select>
          </label>
          {form.status !== "REVIEWING" && <label>Outcome
            <select value={form.resolution} onChange={(event) => setForm({ ...form, resolution: event.target.value })}>
              {RESOLUTIONS.map((resolution) => <option key={resolution.value} value={resolution.value}>{resolution.label}</option>)}
            </select>
          </label>}
          <label>Note
            <input type="text" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="What was decided, and why" />
          </label>
          <button disabled={busy === "resolve" || (form.status !== "REVIEWING" && form.note.trim().length < 4)}>
            <Gavel size={16}/>{busy === "resolve" ? "Recording…" : "Record the decision"}
          </button>
        </form>}
      <p className="console-note">
        <AlertTriangle size={13}/> A refund decision is a judgement, not a payment. Cancel the booking in the vacation console to reverse its ledger entry, and repay the passenger where refunds are processed.
      </p>
    </section>}
  </main>;
}

function OrganizerDisputes() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [form, setForm] = useState({ bookingReference: "", category: "BOOKING", subject: "", details: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/disputes", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your disputes could not be loaded.");
      setDisputes(data.disputes || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your disputes could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(load); }, [load]);

  const raise = useCallback(async () => {
    setBusy("raise"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/disputes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "OPEN", ...form }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That could not be raised.");
      setNotice("Raised. The platform team sees it and the reply goes to your account email.");
      setForm({ bookingReference: "", category: "BOOKING", subject: "", details: "" });
      await load();
    } catch (raiseError) {
      setError(raiseError instanceof Error ? raiseError.message : "That could not be raised.");
    } finally {
      setBusy("");
    }
  }, [form, load]);

  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><Store size={15}/>Organizer</span>
        <Link href="/console/trips"><Scale size={16}/>My trips</Link>
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>DISPUTES</p>
      <h1>Problems with a booking</h1>
      <span>Raise what went wrong on one of your trips. The platform decides, and you can see the outcome here.</span>
    </section>

    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    <section className="console-panel">
      <h2><MessageSquareWarning size={18}/>Raise a dispute</h2>
      <form className="console-form" onSubmit={(event) => { event.preventDefault(); void raise(); }}>
        <label>Booking reference
          <input type="text" required value={form.bookingReference} onChange={(event) => setForm({ ...form, bookingReference: event.target.value })} placeholder="UMX-XXXXXX" />
        </label>
        <label>What is it about
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            {CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
          </select>
        </label>
        <label>Title
          <input type="text" required value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder="Passenger did not board" />
        </label>
        <label>What happened
          <input type="text" required value={form.details} onChange={(event) => setForm({ ...form, details: event.target.value })} placeholder="Include dates, times and anything you can evidence" />
        </label>
        <button disabled={busy === "raise"}><MessageSquareWarning size={16}/>{busy === "raise" ? "Raising…" : "Raise dispute"}</button>
      </form>
    </section>

    <section className="console-panel">
      <h2><Scale size={18}/>Your disputes</h2>
      {disputes.length === 0
        ? <p className="console-empty">Nothing raised. Disputes about your trips appear here with the decision.</p>
        : <table className="console-table">
          <thead><tr><th>Raised</th><th>About</th><th>From</th><th>Status</th><th>Decision</th></tr></thead>
          <tbody>
            {disputes.map((dispute) => (
              <tr key={dispute.id}>
                <td>{when(dispute.createdAt)}</td>
                <td><span>{dispute.subject}</span><small>{dispute.bookingReference || "—"}</small></td>
                <td>{dispute.raisedByRole.toLowerCase()}</td>
                <td><span className={`console-badge console-badge-${dispute.status.toLowerCase()}`}>{dispute.status}</span></td>
                <td>
                  <span>{dispute.resolution ? dispute.resolution.replace(/_/g, " ").toLowerCase() : "—"}</span>
                  {dispute.resolutionNote && <small>{dispute.resolutionNote}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
    </section>
  </main>;
}
