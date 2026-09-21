"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, CreditCard, IdCard, Info, ShieldAlert } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

const ID_TYPES = [
  { value: "GHANA_CARD", label: "Ghana Card" },
  { value: "PASSPORT", label: "Passport" },
  { value: "DRIVER_LICENSE", label: "Driver's licence" },
  { value: "VOTER_ID", label: "Voter ID" },
] as const;

type PayoutDestination = { code: string; name: string };
type Destinations = { MOMO: PayoutDestination[] };
type Fees = { transferFee: number; checkoutPercent: number };

const EMPTY_DESTINATIONS: Destinations = { MOMO: [] };
const EMPTY_FEES: Fees = { transferFee: 0, checkoutPercent: 0 };

/** `GH₵ 1.00` — the same money format the rest of the console uses. */
const cedis = (pesewas: number) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const percent = (basisPoints: number) => `${(Number(basisPoints || 0) / 100).toFixed(Number(basisPoints || 0) % 100 === 0 ? 0 : 2)}%`;

type Profile = {
  organizerId: string; commissionBps: number; kycStatus: string; kycIdType: string; kycIdNumberMasked: string; kycReason: string;
  payoutMethod: string; payoutAccountName: string; payoutAccountMasked: string;
  payoutBankCode: string; payoutBankName: string; payoutRecipientReady: boolean;
};

export default function OrganizerProfilePage() {
  return <ConsoleSessionGate label="your business profile">
    {(session) => session.account.role === "ORGANIZER"
      ? <ProfileWorkspace session={session} />
      : <ConsoleUnavailable session={session} service="profile" label="BUSINESS PROFILE" blurb="This page belongs to an organizer account." />}
  </ConsoleSessionGate>;
}

function ProfileWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [kyc, setKyc] = useState({ idType: "GHANA_CARD", idNumber: "" });
  const [payout, setPayout] = useState({ method: "MOMO", accountName: "", accountNumber: "", bankCode: "" });
  const [destinations, setDestinations] = useState<Destinations>(EMPTY_DESTINATIONS);
  const [fees, setFees] = useState<Fees>(EMPTY_FEES);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/organizers/profile", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your profile could not be loaded.");
      setProfile(data.profile);
      setDestinations(data.destinations || EMPTY_DESTINATIONS);
      setFees(data.fees || EMPTY_FEES);
      if (data.profile?.kycIdType) setKyc((current) => ({ ...current, idType: data.profile.kycIdType }));
      if (data.profile?.payoutMethod) {
        setPayout((current) => ({
          ...current,
          // The rail is fixed: a saved bank account from before the rule is
          // shown for what it is and replaced by the next save.
          method: "MOMO",
          accountName: data.profile.payoutAccountName || "",
          bankCode: data.profile.payoutMethod === "MOMO" ? data.profile.payoutBankCode || "" : "",
        }));
      }
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

  return <ConsoleShell
    session={session}
    service="profile"
    label="BUSINESS PROFILE"
    title="Verification and payouts"
    blurb="Verification decides whether money may be paid out. It never changes whether you can sign in or publish a trip."
  >

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
          <input type="text" value="Mobile money only" readOnly aria-readonly="true" />
        </label>
        <label>Network
          <select required value={payout.bankCode} onChange={(event) => setPayout({ ...payout, bankCode: event.target.value })}>
            <option value="">Choose the network</option>
            {(destinations.MOMO || []).map((destination) => (
              <option key={destination.code} value={destination.code}>{destination.name}</option>
            ))}
          </select>
        </label>
        <label>Account holder
          <input type="text" required value={payout.accountName} onChange={(event) => setPayout({ ...payout, accountName: event.target.value })} />
        </label>
        <label>Mobile money number
          <input type="text" required value={payout.accountNumber} onChange={(event) => setPayout({ ...payout, accountNumber: event.target.value })} placeholder={profile?.payoutAccountMasked || "0240000000"} />
        </label>
        <button disabled={busy === "payout"}><CreditCard size={16}/>{busy === "payout" ? "Saving…" : "Save payout details"}</button>
      </form>
      <p className="console-note">
        <ShieldAlert size={13}/> The number is encrypted at rest and shown to administrators masked; opening it in full is recorded in the audit log.
      </p>
      <p className="console-note">
        Payouts are addressed to this exact account, so changing any detail here retires the saved payee and the next payout is addressed again.
      </p>
      {profile?.payoutMethod && profile.payoutMethod !== "MOMO" && <div className="console-alert" role="alert">
        The saved account is a bank account, and rides no longer pay out to banks. Save a mobile money account to be paid again.
      </div>}
      <p className="console-note"><Info size={13}/> <strong>What a payout costs you</strong></p>
      <p className="console-note">
        <strong>{cedis(fees.transferFee)}</strong> is Paystack&rsquo;s charge for sending money to mobile money, and it is deducted from what you receive: a{" "}
        {cedis(10000)} payout arrives as {cedis(10000 - fees.transferFee)}. That fee is the reason rides pay out to mobile money only — the same transfer
        to a bank account costs GHS 8.00.
      </p>
      <p className="console-note">
        <strong>{profile ? percent(profile.commissionBps) : "—"}</strong> platform commission is taken out of each fare before the amount above reaches
        your statement. Nothing else comes out of your earnings: Paystack&rsquo;s <strong>{fees.checkoutPercent}%</strong> checkout charge is paid by the
        passenger on top of the fare.
      </p>
    </section>
  </ConsoleShell>;
}
