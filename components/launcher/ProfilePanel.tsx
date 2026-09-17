"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Check, LogOut, ShieldCheck, Ticket, User, X } from "lucide-react";
import { ticketHref, writeProfile } from "@/lib/passenger-profile";
import type { StudentAccount } from "@/lib/student-auth";
import { publishStudentAccount, useStudentAccount } from "@/components/account/useStudentAccount";
import { usePassenger } from "./usePassenger";

const formatSavedAt = (value: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

export function ProfilePanel() {
  const { tickets, forgetTicket } = usePassenger();
  const { ready, account } = useStudentAccount();
  const [form, setForm] = useState({ name: "", phone: "" });
  const [status, setStatus] = useState("");
  // Saving and signing out both wait on the database, so the button that was
  // pressed says what it is doing instead of leaving a dead label on screen.
  const [busy, setBusy] = useState<"" | "save" | "signout">("");
  const [seeded, setSeeded] = useState(false);

  // The panel can open before the account request lands, so the saved name and
  // number are filled in as soon as they arrive. Anything already typed wins.
  useEffect(() => {
    if (seeded || !account) return;
    queueMicrotask(() => {
      setForm(current => (current.name || current.phone ? current : { name: account.name, phone: account.phone }));
      setSeeded(true);
    });
  }, [account, seeded]);

  const save = async () => {
    setBusy("save"); setStatus("");
    try {
      const response = await fetch("/api/auth/student", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name, phone: form.phone }),
      });
      const data = await response.json() as { account?: StudentAccount; error?: string };
      if (!response.ok || !data.account) throw new Error(data.error || "Your details could not be saved.");
      writeProfile({ name: data.account.name, email: data.account.email, phone: data.account.phone });
      publishStudentAccount(data.account);
      setStatus("Saved to your UMaTeXPRESS account.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Your details could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const signOut = async () => {
    setBusy("signout");
    try { await fetch("/api/auth/student", { method: "DELETE", credentials: "same-origin" }); } catch { /* the account page clears the cookie server-side */ }
    publishStudentAccount(null);
    setForm({ name: "", phone: "" });
    setStatus("Signed out on this device.");
    setBusy("");
  };

  const ticketsBlock = <section className="profile-tickets" aria-labelledby="profile-tickets-title">
    <div className="profile-tickets-head">
      <h3 id="profile-tickets-title">Tickets opened on this device</h3>
      <span>{tickets.length ? `${tickets.length} saved` : "None yet"}</span>
    </div>
    {tickets.length
      ? <ul>{tickets.map(ticket => <li key={ticket.reference}>
          <span className="profile-ticket-icon"><Ticket size={17} aria-hidden /></span>
          <div>
            <strong>{ticket.kind === "campus" ? "campusRide" : "vacationRide"} ticket</strong>
            <small>…{ticket.reference.slice(-8).toUpperCase()}{ticket.savedAt ? ` · ${formatSavedAt(ticket.savedAt)}` : ""}</small>
          </div>
          <Link href={ticketHref(ticket)}>Open ticket<ArrowRight size={14} aria-hidden /></Link>
          <button aria-label={`Remove ticket ${ticket.reference} from this device`} onClick={() => { forgetTicket(ticket.reference); setStatus("Ticket reference removed from this device. The ticket itself is still valid."); }}><X size={15} aria-hidden /></button>
        </li>)}</ul>
      : <p className="profile-empty"><User size={18} aria-hidden /> Open a ticket on this device and its reference will be listed here. This is not a full booking history — the server only knows the references you still have.</p>}
  </section>;

  if (ready && account) return <div className="profile-panel">
    <div className="profile-account">
      <span className="profile-account-badge"><ShieldCheck size={16} aria-hidden /> Signed in</span>
      <strong>{account.email}</strong>
      <p className="profile-note">One account for campusRide and vacationRide. Only UMaT student addresses can hold an account.</p>
    </div>
    <div className="profile-fields">
      <label><span>Full name</span><input autoComplete="name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="e.g. Ama Mensah" /></label>
      <label><span>Mobile Money number</span><input inputMode="tel" autoComplete="tel" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} placeholder="05X XXX XXXX" /></label>
    </div>
    <div className="profile-actions">
      <button className="profile-save" disabled={busy !== ""} onClick={save}><Check size={16} aria-hidden /> {busy === "save" ? "Saving…" : "Save details"}</button>
      <button className="profile-forget" disabled={busy !== ""} onClick={signOut}>{busy === "signout" ? "Signing out…" : <><LogOut size={15} aria-hidden /> Sign out</>}</button>
    </div>
    {status && <p className="profile-status" role="status">{status}</p>}
    {ticketsBlock}
  </div>;

  return <div className="profile-panel">
    <div className="profile-account">
      <span className="profile-account-badge is-guest"><User size={16} aria-hidden /> Guest</span>
      <strong>Browsing without an account</strong>
      <p className="profile-note">
        Search rides, compare fares and open a ticket without signing in. Holding a seat or joining a campus ride
        queue needs your UMaT student account — one account for both services, limited to @st.umat.edu.gh.
      </p>
    </div>
    <div className="profile-actions">
      <Link className="profile-save" href="/account?next=%2F">Sign in</Link>
      <Link className="profile-forget" href="/account?next=%2F">Create account</Link>
    </div>
    {status && <p className="profile-status" role="status">{status}</p>}
    {ticketsBlock}
  </div>;
}
