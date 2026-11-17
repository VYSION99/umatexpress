"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Buildings, FloppyDisk, GearSix, LockKey, SignOut, UserCircle } from "@/components/ui/MaterialIcon";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { PasskeySettings } from "@/components/account/PasskeyControls";
import { ProfileAvatar, ProfilePhotoEditor } from "@/components/account/ProfilePhoto";
import "./account.css";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Administrator",
  MODERATOR: "Moderator",
  ORGANIZER: "Organizer",
  LANDLORD: "Landlord",
  DRIVER: "Driver",
};

function workSettings(session: ConsoleSessionInfo) {
  const account = session.account;
  if (account.role === "LANDLORD") return { href: "/console/hostels/onboarding", label: "Hostel setup & verification", detail: "Property, identity, payout and staff review progress" };
  if (account.role === "ORGANIZER") return { href: "/console/profile", label: "Business verification & payouts", detail: "Manage your organizer identity and payment destination" };
  if (account.role === "DRIVER") return { href: "/console/driver", label: "Driver workspace", detail: "Your trips, boarding and queue" };
  if (account.role === "VENDOR") return { href: "/console/food", label: "Food vendor workspace", detail: "Pickup requests and handovers" };
  if (account.role === "ADMIN" && (account.delegateServices === undefined || account.delegateServices.includes("settings"))) return { href: "/console/settings", label: "Platform settings", detail: "Service-wide controls for authorized administrators" };
  return null;
}

export default function ConsoleAccountPage() {
  return <ConsoleSessionGate label="your account">{session => <AccountWorkspace session={session} />}</ConsoleSessionGate>;
}

function AccountWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const router = useRouter();
  const [name, setName] = useState(session.account.name);
  const [phone, setPhone] = useState(session.account.phone || "");
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [studentLink, setStudentLink] = useState<{ linked: boolean; name?: string } | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/console/account/link", { credentials: "same-origin", cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then((data: { student?: { linked: boolean; name?: string } } | null) => { if (active && data?.student) setStudentLink(data.student); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [session.account.id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/account", {
        method: "PATCH", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Your profile could not be saved.");
      setName(result.profile.name); setPhone(result.profile.phone);
      setNotice("Your console profile has been updated.");
      window.dispatchEvent(new Event("console-profile-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your profile could not be saved.");
    } finally { setBusy(false); }
  }

  async function signOut() {
    setSigningOut(true); setError("");
    try {
      const response = await fetch("/api/console/session", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Sign-out failed.");
      router.replace("/console/login");
    } catch {
      setError("Could not sign out. Check your connection and try again.");
      setSigningOut(false);
    }
  }

  const settings = workSettings(session);
  const role = session.account.delegateServices !== undefined ? "Admin delegate" : ROLE_LABEL[session.account.role] || session.account.role;

  return <ConsoleShell session={session} service="account" label="YOUR ACCOUNT" title="My account" blurb="Keep your console contact details current and open the settings you are allowed to manage.">
    <div className="console-profile-page">
      {error && <p className="console-alert" role="alert">{error}</p>}
      {notice && <p className="console-alert console-alert-ok" role="status">{notice}</p>}
      <section className="console-profile-card" id="profile" aria-labelledby="console-profile-title">
        <div className="console-profile-identity"><ProfileAvatar scope="CONSOLE" name={session.account.name} className="console-profile-avatar" /><div><span>PERSONAL PROFILE</span><h2 id="console-profile-title">{session.account.name}</h2><p>{role} · {session.account.status.toLowerCase()} account</p></div></div>
        <form onSubmit={save} className="console-profile-form">
          <label>Display name<input required minLength={2} maxLength={80} autoComplete="name" value={name} onChange={event => setName(event.target.value)} /></label>
          <label>Contact number<input type="tel" maxLength={24} autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Optional" /></label>
          <label className="console-profile-email">Sign-in email<input readOnly aria-readonly="true" value={session.account.email} /></label>
          <p>These details identify your console account. Legal identity, property, and payout records have their own review process in your workspace.</p>
          <button type="submit" disabled={busy || (name.trim() === session.account.name && phone.trim() === (session.account.phone || ""))}><FloppyDisk size={18}/>{busy ? "Saving…" : "Save profile"}</button>
        </form>
        <div id="photo" className="console-profile-photo"><ProfilePhotoEditor scope="CONSOLE" name={session.account.name} /></div>
      </section>

      <section className="console-profile-card console-linked-card" aria-labelledby="console-linked-title">
        <span className="console-profile-kicker">CONNECTED PROFILE</span>
        <h2 id="console-linked-title">Student account</h2>
        <p>{studentLink === null ? "Checking for a verified student profile…" : studentLink.linked ? `Linked to ${studentLink.name} through ${session.account.email}.` : `No verified student account is linked to ${session.account.email}.`}</p>
        <small>Student and console accounts use separate passwords and sign-ins. Linking a verified email does not change console permissions.</small>
      </section>

      {!session.mustChangePassword && <section className="console-profile-card console-passkey-card" aria-label="Passkey security"><span className="console-profile-kicker">SIGN-IN SECURITY</span><PasskeySettings scope="CONSOLE" /></section>}

      <section className="console-profile-card" id="settings" aria-labelledby="console-settings-title">
        <div className="console-profile-section-heading"><GearSix size={22}/><div><span>ACCOUNT ACTIONS</span><h2 id="console-settings-title">Settings & security</h2></div></div>
        <div className="console-profile-actions">
          <Link href="/console/change-password"><LockKey size={21}/><span><strong>Change password</strong><small>Update the password that protects this account</small></span><ArrowRight size={18}/></Link>
          {settings && <Link href={settings.href}><Buildings size={21}/><span><strong>{settings.label}</strong><small>{settings.detail}</small></span><ArrowRight size={18}/></Link>}
          <Link href="/console"><UserCircle size={21}/><span><strong>Console home</strong><small>Return to your assigned services</small></span><ArrowRight size={18}/></Link>
          <button type="button" onClick={() => void signOut()} disabled={signingOut}><SignOut size={21}/><span><strong>{signingOut ? "Signing out…" : "Sign out"}</strong><small>End this console session</small></span><ArrowRight size={18}/></button>
        </div>
      </section>
    </div>
  </ConsoleShell>;
}
