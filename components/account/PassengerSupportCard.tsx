"use client";

import { useCallback, useEffect, useState } from "react";
import { LifeBuoy, MessageSquareWarning } from "lucide-react";
import { useStudentAccount } from "./useStudentAccount";

type Dispute = {
  id: string; subject: string; category: string; status: string; bookingReference: string;
  resolution: string; resolutionNote: string; createdAt: string;
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

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

/**
 * Raising a problem with a trip the passenger booked.
 *
 * There is no contact field on purpose: the reply address is the account's own
 * email, which is also the one the booking was made under, so a dispute can
 * only ever be filed against a booking that belongs to the signed-in student.
 */
export function PassengerSupportCard() {
  const { ready, account } = useStudentAccount();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [form, setForm] = useState({ bookingReference: "", category: "BOOKING", subject: "", details: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/disputes", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      setDisputes(data.disputes || []);
    } catch { /* the panel stays empty rather than blocking the account page */ }
  }, []);

  useEffect(() => {
    if (ready && account) queueMicrotask(load);
  }, [ready, account, load]);

  if (!ready || !account) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/disputes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That could not be sent.");
      setNotice("Sent. The platform team sees it and replies to your account email.");
      setForm({ bookingReference: "", category: "BOOKING", subject: "", details: "" });
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "That could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="campus-auth-card passenger-support">
    <strong><LifeBuoy size={15} aria-hidden /> Something went wrong with a trip?</strong>
    <small>Raise it here and the platform decides. The reply goes to {account.email}.</small>
    <form onSubmit={submit}>
      <label>Booking reference<input required value={form.bookingReference} onChange={(event) => setForm({ ...form, bookingReference: event.target.value })} placeholder="UMX-XXXXXX" /></label>
      <label>What it is about
        <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
          {CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
        </select>
      </label>
      <label>Title<input required value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder="The coach left without me" /></label>
      <label>What happened
        <input required value={form.details} onChange={(event) => setForm({ ...form, details: event.target.value })} placeholder="Dates, times and anything you can evidence" />
      </label>
      {error && <p className="campus-ai-error" role="alert">{error}</p>}
      {notice && !error && <p className="student-auth-hint" role="status">{notice}</p>}
      <button disabled={busy}><MessageSquareWarning size={15} aria-hidden /> {busy ? "Sending…" : "Send to the platform"}</button>
    </form>
    {disputes.length > 0 && <table className="console-table passenger-support-list">
      <thead><tr><th>Raised</th><th>About</th><th>Status</th></tr></thead>
      <tbody>
        {disputes.map((dispute) => (
          <tr key={dispute.id}>
            <td>{when(dispute.createdAt)}</td>
            <td><span>{dispute.subject}</span><small>{dispute.bookingReference || dispute.category.toLowerCase()}</small></td>
            <td>
              <span className={`console-badge console-badge-${dispute.status.toLowerCase()}`}>{dispute.status}</span>
              {dispute.resolutionNote && <small>{dispute.resolutionNote}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>}
  </section>;
}
