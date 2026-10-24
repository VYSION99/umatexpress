"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Key, ShieldCheck, SignOut, Ticket, User, X } from "@/components/ui/MaterialIcon";
import { clearProfile, clearSavedTickets, notifyPassengerChanged, ticketHref } from "@/lib/passenger-profile";
import { publishStudentAccount, useStudentAccount } from "@/components/account/useStudentAccount";
import { ProfileAvatar } from "@/components/account/ProfilePhoto";
import { usePassenger } from "./usePassenger";

const formatSavedAt = (value: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

export function ProfilePanel({ ticketsOnly = false }: { ticketsOnly?: boolean }) {
  const { tickets, forgetTicket } = usePassenger();
  const { ready, account } = useStudentAccount();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true); setStatus("");
    try {
      const response = await fetch("/api/auth/student", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
      clearProfile();
      clearSavedTickets();
      notifyPassengerChanged();
      publishStudentAccount(null);
      setStatus("Signed out on this device.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not sign out."); }
    finally { setBusy(false); }
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
      : <p className="profile-empty"><User size={18} aria-hidden /> Ticket links you open on this device will appear here.</p>}
  </section>;

  if (ticketsOnly) return <div className="profile-panel">{status && <p className="profile-status" role="status">{status}</p>}{ticketsBlock}</div>;

  if (ready && account) return <div className="profile-panel">
    <div className="profile-account">
      <div className="profile-panel-identity"><ProfileAvatar scope="STUDENT" name={account.name} /><div><span className="profile-account-badge"><ShieldCheck size={16} aria-hidden /> {account.emailVerified ? "Verified account" : "Email not verified"}</span><strong>{account.name || account.email}</strong><small>{account.email}</small></div></div>
    </div>
    <div className="profile-actions">
      <Link className="profile-save" href="/profile"><User size={16} aria-hidden /> View profile</Link>
      <Link className="profile-forget" href="/profile#security"><Key size={16} aria-hidden /> Security</Link>
    </div>
    <button className="profile-forget" disabled={busy} onClick={() => void signOut()}><SignOut size={16} aria-hidden /> {busy ? "Signing out…" : "Sign out"}</button>
    {status && <p className="profile-status" role="status">{status}</p>}
  </div>;

  return <div className="profile-panel">
    <div className="profile-account">
      <span className="profile-account-badge is-guest"><User size={16} aria-hidden /> Guest</span>
      <strong>Browsing without an account</strong>
      <p className="profile-note">
        Explore rides, hostels and Cinema without signing in. A UMaT student account is needed for ride bookings;
        any verified account can take part in eligible Cinema events.
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
