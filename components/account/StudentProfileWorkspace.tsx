"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, Key, ShieldCheck, SignOut, Ticket, User } from "@/components/ui/MaterialIcon";
import { useStudentAccount, publishStudentAccount } from "./useStudentAccount";
import { PasskeySettings } from "./PasskeyControls";
import { ProfileAvatar, ProfilePhotoEditor } from "./ProfilePhoto";
import { ProfilePanel } from "@/components/launcher/ProfilePanel";
import { validStudentEmail } from "@/lib/student-email";
import { clearProfile, clearSavedTickets, notifyPassengerChanged, writeProfile } from "@/lib/passenger-profile";
import type { StudentAccount } from "@/lib/student-auth";
import "./student-profile.css";

type Tab = "overview" | "personal" | "security" | "activity";
const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "personal", label: "Personal details" },
  { id: "security", label: "Security" }, { id: "activity", label: "Your activity" },
];

export function StudentProfileWorkspace() {
  const { ready, account } = useStudentAccount();
  const [tab, setTab] = useState<Tab>("overview");
  const [draft, setDraft] = useState({ accountId: "", name: "", phone: "" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState<"" | "profile" | "password">("");
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [consoleLink, setConsoleLink] = useState<{ linked: boolean; role?: string } | null>(null);

  useEffect(() => {
    if (!account?.emailVerified) return;
    let active = true;
    void fetch("/api/auth/student/link", { credentials: "same-origin", cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then((data: { console?: { linked: boolean; role?: string } } | null) => { if (active && data?.console) setConsoleLink(data.console); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [account?.id, account?.emailVerified]);

  useEffect(() => {
    const fromHash = () => {
      const requested = window.location.hash.slice(1);
      if (tabs.some(item => item.id === requested) || requested === "passkeys") setTab(requested === "passkeys" ? "security" : requested as Tab);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  if (!ready) return <section className="student-profile-loading" role="status">Loading your profile…</section>;
  if (!account) return <section className="student-profile-guest"><h2>Sign in to see your profile</h2><p>Your account details and security settings appear here after sign-in.</p><Link href="/account?next=%2Fprofile">Sign in <ArrowRight size={16} aria-hidden /></Link></section>;

  const student = validStudentEmail(account.email);
  const verified = account.emailVerified;
  const name = draft.accountId === account.id ? draft.name : account.name;
  const phone = draft.accountId === account.id ? draft.phone : account.phone;

  async function saveDetails(event: FormEvent) {
    event.preventDefault(); setBusy("profile"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/auth/student", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, phone }) });
      const data = await response.json() as { account?: StudentAccount; error?: string };
      if (!response.ok || !data.account) throw new Error(data.error || "Could not save your details.");
      publishStudentAccount(data.account);
      setDraft({ accountId: data.account.id, name: data.account.name, phone: data.account.phone });
      writeProfile({ name: data.account.name, email: data.account.email, phone: data.account.phone });
      setNotice("Your details have been saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save your details."); }
    finally { setBusy(""); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault(); setBusy("password"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/auth/student", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not change your password.");
      setCurrentPassword(""); setNewPassword(""); setNotice("Password changed. Your other sessions will need to sign in again.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change your password."); }
    finally { setBusy(""); }
  }

  async function signOut() {
    setSigningOut(true); setError("");
    try {
      const response = await fetch("/api/auth/student", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
      clearProfile(); clearSavedTickets(); notifyPassengerChanged();
      publishStudentAccount(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign out."); }
    finally { setSigningOut(false); }
  }

  return <div className="student-profile-workspace">
    <header className="student-profile-hero">
      <ProfileAvatar scope="STUDENT" name={account.name} />
      <div><span>{student ? "STUDENT ACCOUNT" : "CINEMA MEMBER"}</span><h2>{account.name || "Your account"}</h2><p>{account.email}</p></div>
      <span className={`student-profile-verification${verified ? " is-verified" : ""}`}><ShieldCheck size={16} aria-hidden />{verified ? "Email verified" : "Email verification needed"}</span>
    </header>
    <div className="student-profile-layout">
      <nav className="student-profile-tabs" aria-label="Profile sections">
        {tabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => { setTab(item.id); setNotice(""); setError(""); window.history.replaceState(null, "", `#${item.id}`); }}>{item.label}<ArrowRight size={15} aria-hidden /></button>)}
      </nav>
      <div className="student-profile-content">
        {notice && <p className="student-profile-notice" role="status"><Check size={17} aria-hidden />{notice}</p>}
        {error && <p className="student-profile-error" role="alert">{error}</p>}
        {tab === "overview" && <>
          <section className="student-profile-card"><span className="student-profile-eyebrow">ACCOUNT OVERVIEW</span><h3>Welcome, {account.name.split(/\s+/)[0] || "friend"}</h3><p>Your profile helps us prepare your bookings and protect your account. Your account photo is private and does not appear to other Cinema participants.</p><div className="student-profile-summary"><div><small>Account type</small><strong>{student ? "UMaT student" : "Cinema member"}</strong></div><div><small>Email</small><strong>{verified ? "Verified" : "Needs verification"}</strong></div><div><small>Last sign-in</small><strong>{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleDateString() : "Not available"}</strong></div></div></section>
          {!verified && <section className="student-profile-card student-profile-attention"><h3>Verify your email</h3><p>Verification is needed before you can add a passkey or join activities that require a verified account.</p><Link href="/account?next=%2Fprofile">Open verification <ArrowRight size={16} aria-hidden /></Link></section>}
          {verified && <section className="student-profile-card student-linked-card"><span className="student-profile-eyebrow">CONNECTED PROFILE</span><h3>Console account</h3><p>{consoleLink === null ? "Checking for a console profile…" : consoleLink.linked ? `Your verified email also belongs to an active ${consoleLink.role} console account.` : "No active console account is linked to this verified email."} Student and console sign-ins stay separate; this profile does not grant staff access.</p></section>}
          <div className="student-profile-shortcuts"><button onClick={() => setTab("personal")}><User size={19} aria-hidden /><span><strong>Personal details</strong><small>Contact details and photo</small></span><ArrowRight size={16} aria-hidden /></button><button onClick={() => setTab("security")}><Key size={19} aria-hidden /><span><strong>Security</strong><small>Password and passkeys</small></span><ArrowRight size={16} aria-hidden /></button></div>
          <button className="student-profile-signout" type="button" disabled={signingOut} onClick={() => void signOut()}><SignOut size={16} aria-hidden />{signingOut ? "Signing out…" : "Sign out on this device"}</button>
        </>}
        {tab === "personal" && <>
          <section className="student-profile-card"><span className="student-profile-eyebrow">YOUR DETAILS</span><h3>Personal information</h3><p>Your sign-in email is fixed here. Account email changes require a separate verification flow.</p><form className="student-profile-form" onSubmit={saveDetails}><label>Full name<input required maxLength={100} autoComplete="name" value={name} onChange={event => setDraft({ accountId: account.id, name: event.target.value, phone })} /></label><label>Contact number<input type="tel" maxLength={30} autoComplete="tel" value={phone} onChange={event => setDraft({ accountId: account.id, name, phone: event.target.value })} placeholder="Optional" /></label><label>Sign-in email<input readOnly value={account.email} /></label><button disabled={busy !== "" || (name.trim() === account.name && phone.trim() === account.phone)}>{busy === "profile" ? "Saving…" : "Save details"}</button></form></section>
          <section className="student-profile-card"><ProfilePhotoEditor scope="STUDENT" name={account.name} /></section>
        </>}
        {tab === "security" && <>
          <section className="student-profile-card" id="security"><span className="student-profile-eyebrow">SIGN-IN SECURITY</span><h3>Change password</h3><p>Use your current password to protect this change. You can also <Link href="/reset-password">recover a forgotten password</Link>.</p><form className="student-profile-form" onSubmit={changePassword}><label>Current password<input required type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label><label>New password<input required type="password" minLength={10} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label><small>At least 10 characters with uppercase, lowercase, a number and a symbol.</small><button disabled={busy !== ""}>{busy === "password" ? "Updating…" : "Update password"}</button></form></section>
          {verified ? <section className="student-profile-card"><PasskeySettings scope="STUDENT" /></section> : <section className="student-profile-card"><h3>Passkeys</h3><p>Verify your email before you add a passkey.</p><Link href="/account?next=%2Fprofile">Open verification <ArrowRight size={16} aria-hidden /></Link></section>}
        </>}
        {tab === "activity" && <>
          <section className="student-profile-card"><span className="student-profile-eyebrow">YOUR SERVICES</span><h3>Continue where you left off</h3><div className="student-profile-service-links"><Link href="/campus/ticket">CampusRide tickets <ArrowRight size={16} aria-hidden /></Link><Link href="/hostel/resident">Hostel residency <ArrowRight size={16} aria-hidden /></Link><Link href="/cinema/rooms">Cinema rooms <ArrowRight size={16} aria-hidden /></Link></div></section>
          <section className="student-profile-card"><span className="student-profile-eyebrow"><Ticket size={15} aria-hidden /> THIS DEVICE</span><ProfilePanel ticketsOnly /></section>
        </>}
      </div>
    </div>
  </div>;
}
