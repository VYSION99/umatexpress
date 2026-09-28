"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

const SERVICE_CHOICES = [
  { id: "campus", label: "CampusRide" }, { id: "vacation", label: "VacationRide" },
  { id: "organizers", label: "Organizer applications" }, { id: "hostels", label: "Hostel Finder" },
  { id: "payouts", label: "Payouts" }, { id: "disputes", label: "Disputes" },
  { id: "cinema", label: "OnlineCinema" }, { id: "settings", label: "Platform settings" },
] as const;

type Delegate = { id: string; name: string; email: string; status: string; services: string[]; mustChangePassword: boolean; createdAt: string };

function ServicePicker({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  return <fieldset className="delegate-services">
    <legend>Console access</legend>
    <p>Choose the services this person can open and manage. Account delegation stays with the primary administrator.</p>
    <div className="delegate-service-grid">{SERVICE_CHOICES.map((service) => <label key={service.id}>
      <input type="checkbox" checked={value.includes(service.id)} onChange={(event) => onChange(event.target.checked ? [...value, service.id] : value.filter((id) => id !== service.id))}/>
      <span>{service.label}</span>
    </label>)}</div>
  </fieldset>;
}

export default function ConsoleDelegatesPage() {
  return <ConsoleSessionGate label="admin delegates">{(session) => session.account.role === "ADMIN" && session.account.delegateServices === undefined
    ? <DelegateWorkspace session={session}/>
    : <ConsoleUnavailable session={session} service="delegates" label="TEAM ACCESS" blurb="Only a primary administrator can manage delegate accounts."/>}</ConsoleSessionGate>;
}

function DelegateWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [services, setServices] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/delegates", { cache: "no-store", credentials: "same-origin" });
      const data = await response.json() as { delegates?: Delegate[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Delegate accounts could not be loaded.");
      setDelegates(data.delegates || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Delegate accounts could not be loaded."); }
  }, []);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy("create"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/delegates", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password, services }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Delegate account could not be created.");
      setName(""); setEmail(""); setPassword(""); setServices([]);
      setNotice("Delegate created. Give them their temporary password through a secure channel; they must change it on first sign-in.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Delegate account could not be created."); }
    finally { setBusy(""); }
  }

  async function save(delegate: Delegate, nextServices: string[], nextStatus: string) {
    setBusy(delegate.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/delegates", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: delegate.id, status: nextStatus, services: nextServices }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Delegate access could not be updated.");
      setNotice(`${delegate.name}'s access was updated. Their existing sessions have ended.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Delegate access could not be updated."); }
    finally { setBusy(""); }
  }

  return <ConsoleShell session={session} service="delegates" label="ADMINISTRATION · TEAM ACCESS" title="Admin delegates" blurb="Give teammates access to the consoles they manage. Every change ends their active sessions.">
    {error && <p className="console-alert" role="alert">{error}</p>}
    {notice && <p className="delegate-notice" role="status">{notice}</p>}
    <section className="delegate-panel" aria-labelledby="delegate-create-title">
      <div className="delegate-heading"><span>01 · NEW ACCOUNT</span><h2 id="delegate-create-title">Invite a delegate</h2><p>Create a named account with a temporary password. The delegate changes it before using any service.</p></div>
      <form onSubmit={create} className="delegate-form">
        <div className="delegate-fields">
          <label>Full name<input required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Ama Mensah"/></label>
          <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com"/></label>
          <label>Temporary password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="12+ characters, mixed case, number, symbol"/></label>
        </div>
        <ServicePicker value={services} onChange={setServices}/>
        <button type="submit" className="delegate-primary" disabled={busy !== "" || !services.length}>{busy === "create" ? "Creating…" : "Create delegate"}</button>
      </form>
    </section>
    <section className="delegate-list" aria-labelledby="delegate-list-title">
      <div className="delegate-heading"><span>02 · ACTIVE ACCESS</span><h2 id="delegate-list-title">Manage delegates</h2><p>Change service access or suspend an account. Changes take effect on the next request.</p></div>
      {delegates.length ? delegates.map((delegate) => <DelegateCard key={`${delegate.id}:${delegate.status}:${delegate.services.join(",")}`} delegate={delegate} busy={busy === delegate.id} onSave={save}/>) : <p className="delegate-empty">No delegate accounts yet.</p>}
    </section>
  </ConsoleShell>;
}

function DelegateCard({ delegate, busy, onSave }: { delegate: Delegate; busy: boolean; onSave: (delegate: Delegate, services: string[], status: string) => Promise<void> }) {
  const [services, setServices] = useState(delegate.services);
  const changed = JSON.stringify([...services].sort()) !== JSON.stringify([...delegate.services].sort());
  return <article className="delegate-card">
    <header><div><h3>{delegate.name}</h3><p>{delegate.email}</p></div><span className={`delegate-status ${delegate.status === "ACTIVE" ? "active" : ""}`}>{delegate.status === "ACTIVE" ? "Active" : "Suspended"}</span></header>
    {delegate.mustChangePassword && <p className="delegate-pending">Waiting for first password change</p>}
    <ServicePicker value={services} onChange={setServices}/>
    <div className="delegate-actions">
      <button disabled={busy || !changed || !services.length} onClick={() => void onSave(delegate, services, delegate.status)}>{busy ? "Saving…" : "Save access"}</button>
      <button className="delegate-secondary" disabled={busy} onClick={() => void onSave(delegate, services, delegate.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}>{delegate.status === "ACTIVE" ? "Suspend account" : "Reactivate account"}</button>
    </div>
  </article>;
}
