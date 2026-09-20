"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BedDouble, Building2, MapPin, Plus, ShieldCheck } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

type Landlord = {
  id: string; name: string; phone: string; email: string; organization: string;
  status: string; kycStatus: string; reviewReason: string;
};

type Property = {
  id: string; name: string; address: string;
  latitude: number | null; longitude: number | null;
  utilitiesEnabled: boolean; status: string; createdAt: string;
};

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

export default function HostelWorkspacePage() {
  return <ConsoleSessionGate label="your hostel workspace">
    {(session) => session.account.role === "LANDLORD"
      ? <HostelWorkspace session={session} />
      : <ConsoleUnavailable session={session} service="hostels" label="HOSTEL FINDER" blurb="This workspace belongs to a landlord account." />}
  </ConsoleSessionGate>;
}

function HostelWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const [landlord, setLandlord] = useState<Landlord | null>(null);
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [draft, setDraft] = useState({ name: "", address: "", latitude: "", longitude: "", utilitiesEnabled: false });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/hostel/properties", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your hostel workspace could not be loaded.");
      setLandlord(data.landlord);
      setProperties(data.properties || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your hostel workspace could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(load); }, [load]);

  async function addProperty(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved("");
    try {
      const response = await fetch("/api/console/hostel/properties", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The property could not be saved.");
      setProperties((current) => [data.property, ...(current || [])]);
      setDraft({ name: "", address: "", latitude: "", longitude: "", utilitiesEnabled: false });
      setSaved(`${data.property.name} saved as a draft. Rooms and bed-spaces come next.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The property could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <ConsoleShell
    session={session}
    service="hostels"
    label="ACCOMMODATION"
    title="Your hostel workspace"
    blurb="Build the property first, then the rooms and bed-spaces inside it. Students only ever see what review approves."
  >
    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <section className="console-panel">
      <h2><ShieldCheck size={18}/>Landlord account
        {landlord && <span className={`console-badge console-badge-${landlord.kycStatus.toLowerCase()}`}>KYC {landlord.kycStatus}</span>}
      </h2>
      {landlord && <p className="console-note">
        <strong>{landlord.organization || landlord.name}</strong> · {landlord.phone} · {landlord.email}
      </p>}
      <p className="console-note">
        Your account is active and you can build straight away. Verification and payout details arrive before any money moves.
      </p>
    </section>

    <section className="console-panel">
      <h2><Building2 size={18}/>Add a property</h2>
      <form className="console-form" onSubmit={addProperty}>
        <label>Property name
          <input type="text" required minLength={2} maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Green View Hostel" />
        </label>
        <label>Address
          <input type="text" required minLength={3} maxLength={160} value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Near UMaT main gate, Tarkwa" />
        </label>
        <label>Latitude (optional)
          <input type="text" inputMode="decimal" value={draft.latitude} onChange={(event) => setDraft({ ...draft, latitude: event.target.value })} placeholder="5.3009" />
        </label>
        <label>Longitude (optional)
          <input type="text" inputMode="decimal" value={draft.longitude} onChange={(event) => setDraft({ ...draft, longitude: event.target.value })} placeholder="-1.9897" />
        </label>
        <label>
          <span>Utilities fee</span>
          <span><input type="checkbox" checked={draft.utilitiesEnabled} onChange={(event) => setDraft({ ...draft, utilitiesEnabled: event.target.checked })} /> Charge a utilities fee per bed</span>
        </label>
        <button disabled={busy}><Plus size={16}/>{busy ? "Saving…" : "Save property"}</button>
      </form>
      <p className="console-note">
        <MapPin size={13}/> Latitude and longitude place the property on the student map. You can add them later; without them the property still lists.
      </p>
    </section>

    <section className="console-panel">
      <h2><BedDouble size={18}/>Your properties</h2>
      {!properties
        ? <p className="console-empty">Loading your properties…</p>
        : properties.length === 0
          ? <p className="console-empty">No properties yet. Add your first building above.</p>
          : <table className="console-table">
            <thead><tr><th>Property</th><th>Location</th><th>Utilities</th><th>Status</th><th>Added</th></tr></thead>
            <tbody>
              {properties.map((property) => (
                <tr key={property.id}>
                  <td><span>{property.name}</span><small>{property.address || "No address yet"}</small></td>
                  <td>{property.latitude !== null && property.longitude !== null ? `${property.latitude.toFixed(4)}, ${property.longitude.toFixed(4)}` : "Not pinned"}</td>
                  <td>{property.utilitiesEnabled ? "Fee per bed" : "Rent only"}</td>
                  <td><span className={`console-badge console-badge-${property.status.toLowerCase()}`}>{property.status.replace("_", " ")}</span></td>
                  <td>{when(property.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      <p className="console-note">
        A property stays a draft while you build it. Rooms, bed-spaces and photos arrive next, then you submit a listing for review.
      </p>
    </section>
  </ConsoleShell>;
}
