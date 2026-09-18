"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, CreditCard, IdCard, LogOut, ShieldAlert, Store } from "lucide-react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";

const ID_TYPES = [
  { value: "GHANA_CARD", label: "Ghana Card" },
  { value: "PASSPORT", label: "Passport" },
  { value: "DRIVER_LICENSE", label: "Driver's licence" },
  { value: "VOTER_ID", label: "Voter ID" },
] as const;

const PAYOUT_METHODS = [
  { value: "BANK", label: "Bank account" },
  { value: "MOMO", label: "Mobile money" },
] as const;

type Profile = {
  organizerId: string; kycStatus: string; kycIdType: string; kycIdNumberMasked: string; kycReason: string;
  payoutMethod: string; payoutAccountName: string; payoutAccountMasked: string;
};

export default function OrganizerProfilePage() {
  return <ConsoleSessionGate label="your business profile">
    {(session) => session.account.role === "ORGANIZER"
      ? <ProfileWorkspace />
      : <main className="console-page"><section className="console-hero"><h1>Not available</h1><span>This page belongs to an organizer account.</span></section></main>}
  </ConsoleSessionGate>;
}

function ProfileWorkspace() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [kyc, setKyc] = useState({ idType: "GHANA_CARD", idNumber: "" });
  const [payout, setPayout] = useState({ method: "MOMO", accountName: "", accountNumber: "" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/organizers/profile", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your profile could not be loaded.");
      setProfile(data.profile);
      if (data.profile?.kycIdType) setKyc((current) => ({ ...current, idType: data.profile.kycIdType }));
      if (data.profile?.payoutMethod) setPayout((current) => ({ ...current, method: data.profile.payoutMethod, accountName: data.profile.payoutAccountName || "" }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your profile could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(load); }, [load]);

  async function save(section: "kyc" | "payout") {
    setBusy(section); setError(""); setSaved("");
    try {
      const response = await fetch(`/api/console/organizers/profile/${section}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(section === "kyc" ? kyc : payout),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That could not be saved.");
      setProfile(data.profile);
      if (section === "kyc") setKyc((current) => ({ ...current, idNumber: "" }));
      if (section === "payout") setPayout((current) => ({ ...current, accountNumber: "" }));
      setSaved(section === "kyc" ? "KYC submitted for review." : "Payout details saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "That could not be saved.");
    } finally {
      setBusy("");
    }
  }

  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><Store size={15}/>Organizer</span>
        <Link href="/console"><LogOut size={16}/>Back to console</Link>
      </div>
    </header>

    <section className="console-hero">
      <p>BUSINESS PROFILE</p>
      <h1>Verification and payouts</h1>
      <span>Verification decides whether money may be paid out. It never changes whether you can sign in or publish a trip.</span>
    </section>

    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <section className="console-panel">
      <h2><IdCard size={18}/>Identity verification
        {profile && <span className={`console-badge console-badge-${profile.kycStatus.toLowerCase()}`}>{profile.kycStatus}</span>}
      </h2>
      {profile?.kycReason && <p className="console-note">Reviewer said: {profile.kycReason}</p>}
      <form className="console-form" onSubmit={(event) => { event.preventDefault(); void save("kyc"); }}>
        <label>Document type
          <select value={kyc.idType} onChange={(event) => setKyc({ ...kyc, idType: event.target.value })}>
            {ID_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>
        <label>Document number
          <input type="text" required value={kyc.idNumber} onChange={(event) => setKyc({ ...kyc, idNumber: event.target.value })} placeholder={profile?.kycIdNumberMasked || "GHA-000000000-0"} />
        </label>
        <button disabled={busy === "kyc"}><BadgeCheck size={16}/>{busy === "kyc" ? "Submitting…" : "Submit for verification"}</button>
      </form>
      <p className="console-note">Only the document type and number are recorded. No scan is uploaded, so keep the original safe.</p>
    </section>

    <section className="console-panel">
      <h2><CreditCard size={18}/>Payout account</h2>
      <form className="console-form" onSubmit={(event) => { event.preventDefault(); void save("payout"); }}>
        <label>Method
          <select value={payout.method} onChange={(event) => setPayout({ ...payout, method: event.target.value })}>
            {PAYOUT_METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
          </select>
        </label>
        <label>Account holder
          <input type="text" required value={payout.accountName} onChange={(event) => setPayout({ ...payout, accountName: event.target.value })} />
        </label>
        <label>{payout.method === "MOMO" ? "Mobile money number" : "Account number"}
          <input type="text" required value={payout.accountNumber} onChange={(event) => setPayout({ ...payout, accountNumber: event.target.value })} placeholder={profile?.payoutAccountMasked || "0240000000"} />
        </label>
        <button disabled={busy === "payout"}><CreditCard size={16}/>{busy === "payout" ? "Saving…" : "Save payout details"}</button>
      </form>
      <p className="console-note">
        <ShieldAlert size={13}/> The number is encrypted at rest and shown to administrators masked; opening it in full is recorded in the audit log.
      </p>
    </section>
  </main>;
}
