"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle, MapPin, ShieldCheck } from "@phosphor-icons/react";
import { PropertyPhotos } from "@/components/console/hostel/PropertyPhotos";
import { HostelLocationPicker } from "@/components/console/hostel/HostelLocationPicker";
import { HostelRoomBatch } from "@/components/console/hostel/HostelRoomBatch";
import "@/components/console/hostel/onboarding.css";

type Owner = { landlordId: string; name: string; phone: string; email: string; organization: string; ownerRole: string; profileStatus: string; profileReason: string; identityStatus: string; identityReason?: string; payoutStatus: string; payoutReason: string; hasPayoutDestination: boolean };
type Property = { id: string; name: string; address: string; status: string; latitude: number | null; longitude: number | null; utilitiesEnabled: boolean };
type Room = { id: string; label: string; capacity: number; utilitiesFee: number; amenities: string; bedLayout: "SEPARATE" | "BUNK"; status?: string };
type Document = { id: string; kind: string; uploadedAt: string };
type Destination = { code: string; name: string };
type PayoutData = { unavailable?: boolean; isOwner: boolean; account: { method: string; accountName: string; bankCode: string; bankName: string; accountMasked: string; ready: boolean }; destinations: { BANK: Destination[]; MOMO: Destination[] } };
type Suggestion = { label: string; latitude: number; longitude: number };
const EMPTY_PROPERTY = { name: "", address: "", latitude: "", longitude: "", utilitiesEnabled: false, claim: "UNSURE", evidenceNote: "" };
async function json(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That change could not be saved.");
  return data;
}
function badge(status: string) { return <span className={`console-badge console-badge-${status.toLowerCase()}`}>{status.replaceAll("_", " ")}</span>; }
export function HostelOnboarding() {
  const [step, setStep] = useState(0);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [identityDocumentsVisible, setIdentityDocumentsVisible] = useState(true);
  const [ownerRole, setOwnerRole] = useState("OWNER");
  const [organization, setOrganization] = useState("");
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [property, setProperty] = useState({ ...EMPTY_PROPERTY });
  const [rooms, setRooms] = useState<Room[]>([]);
  const [propertyReviewReason, setPropertyReviewReason] = useState("");
  const [room, setRoom] = useState({ label: "", capacity: "2", utilitiesFee: "0", amenities: "", bedLayout: "SEPARATE" });
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [singleRoomOpen, setSingleRoomOpen] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [payoutData, setPayoutData] = useState<PayoutData | null>(null);
  const [payout, setPayout] = useState({ method: "MOMO", bankCode: "", accountName: "", accountNumber: "" });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadProperty = useCallback(async (id: string) => {
    if (!id) { setProperty({ ...EMPTY_PROPERTY }); setRooms([]); setPropertyReviewReason(""); return; }
    const [detail, affiliation] = await Promise.all([
      json(`/api/console/hostel/properties/${encodeURIComponent(id)}`),
      json(`/api/console/hostel/affiliation?propertyId=${encodeURIComponent(id)}`),
    ]);
    const selected = detail.property as Property;
    setProperty({ name: selected.name, address: selected.address, latitude: selected.latitude == null ? "" : String(selected.latitude), longitude: selected.longitude == null ? "" : String(selected.longitude), utilitiesEnabled: selected.utilitiesEnabled, claim: affiliation.affiliation?.claim || "UNSURE", evidenceNote: affiliation.affiliation?.evidenceNote || "" });
    setRooms(detail.rooms || []); setPropertyReviewReason(affiliation.affiliation?.reviewReason || "");
  }, []);
  const load = useCallback(async () => {
    const [profile, supply] = await Promise.all([
      json("/api/console/hostel/onboarding"), json("/api/console/hostel/properties"),
    ]);
    const showIdentityDocuments = profile.identityDocumentsVisible !== false;
    const [evidence, payoutResponse] = await Promise.all([
      showIdentityDocuments ? json("/api/console/hostel/identity") : Promise.resolve({ documents: [] }),
      json("/api/console/hostel/payout-account").catch(() => ({ unavailable: true, isOwner: true, account: { method: "", accountName: "", bankCode: "", bankName: "", accountMasked: "", ready: false }, destinations: { BANK: [], MOMO: [] } })),
    ]);
    const nextOwner = profile.owner as Owner;
    setIdentityDocumentsVisible(showIdentityDocuments);
    setOwner(nextOwner); setOwnerRole(nextOwner.ownerRole); setOrganization(nextOwner.organization);
    setProperties(supply.properties || []); setDocuments(evidence.documents || []); setPayoutData(payoutResponse);
    setPayout(current => ({ ...current, method: payoutResponse.account?.method || "MOMO", bankCode: payoutResponse.account?.bankCode || "", accountName: payoutResponse.account?.accountName || "" }));
    const first = (supply.properties || [])[0] as Property | undefined;
    if (first) { setPropertyId(first.id); await loadProperty(first.id); }
  }, [loadProperty]);
  useEffect(() => { queueMicrotask(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "Onboarding could not load.")); }); }, [load]);
  async function run(label: string, task: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "That change could not be saved."); }
    finally { setBusy(""); }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    await run("profile", async () => {
      const data = await json("/api/console/hostel/onboarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerRole, organization }) });
      setOwner(data.owner); setNotice("Account details sent for their own review.");
    });
  }
  async function saveProperty(event: FormEvent) {
    event.preventDefault();
    await run("property", async () => {
      const data = await json(propertyId ? `/api/console/hostel/properties/${encodeURIComponent(propertyId)}` : "/api/console/hostel/properties", {
        method: propertyId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: property.name, address: property.address, latitude: property.latitude, longitude: property.longitude, utilitiesEnabled: property.utilitiesEnabled }),
      });
      const id = String(data.property.id);
      setPropertyId(id);
      await json("/api/console/hostel/affiliation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId: id, claim: property.claim, evidenceNote: property.evidenceNote }) });
      const supply = await json("/api/console/hostel/properties"); setProperties(supply.properties || []);
      await loadProperty(id);
      setNotice("Property draft saved. Add a room and upload a photo before submitting it for review.");
    });
  }
  async function findAddress() {
    if (property.address.trim().length < 3) return;
    setSearching(true);
    try { const data = await json(`/api/console/hostel/location-search?q=${encodeURIComponent(property.address)}`); setSuggestions(data.suggestions || []); if (data.unavailable) setNotice("Address suggestions are unavailable. Enter the address and set the pin on the map."); }
    catch { setSuggestions([]); setNotice("Address suggestions are unavailable. Enter the address and set the pin on the map."); }
    finally { setSearching(false); }
  }
  async function addRoom(event: FormEvent) {
    event.preventDefault(); if (!propertyId) return;
    await run("room", async () => {
      await json("/api/console/hostel/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId, label: room.label, capacity: Number(room.capacity), utilitiesFee: Math.round(Number(room.utilitiesFee) * 100), amenities: room.amenities, bedLayout: room.bedLayout }) });
      setRoom({ label: "", capacity: "2", utilitiesFee: "0", amenities: "", bedLayout: "SEPARATE" }); setSingleRoomOpen(false); await loadProperty(propertyId); setNotice("Room and its bed spaces added.");
    });
  }
  async function submitProperty() {
    if (!propertyId) return;
    await run("submit-property", async () => {
      await json("/api/console/hostel/properties/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId }) });
      const supply = await json("/api/console/hostel/properties"); setProperties(supply.properties || []);
      setNotice("Property submitted for its own review. Staff will check the photos separately.");
    });
  }
  async function uploadDocument(kind: "IDENTITY" | "AUTHORITY", file: File | undefined) {
    if (!file) return;
    await run(kind, async () => {
      const form = new FormData(); form.set("kind", kind); form.set("file", file);
      await json("/api/console/hostel/identity", { method: "POST", body: form });
      const [evidence, profile] = await Promise.all([json("/api/console/hostel/identity"), json("/api/console/hostel/onboarding")]);
      setDocuments(evidence.documents || []); setOwner(profile.owner); setNotice("Private document received for staff review.");
    });
  }
  async function savePayout(event: FormEvent) {
    event.preventDefault();
    await run("payout", async () => {
      await json("/api/console/hostel/payout-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payout) });
      const [data, profile] = await Promise.all([json("/api/console/hostel/payout-account"), json("/api/console/hostel/onboarding")]);
      setPayoutData(data); setOwner(profile.owner); setPayout(current => ({ ...current, accountNumber: "" }));
      setNotice("Payout destination saved for a separate review. Students cannot book until it is validated.");
    });
  }
  const selected = properties.find(item => item.id === propertyId);
  const labels = ["Account & owner", "Property", "Identity & payouts"];
  const activeStep = Math.min(step, labels.length - 1);
  const states = [owner?.profileStatus || "PENDING", selected?.status || "DRAFT", owner?.identityStatus === "VERIFIED" && owner?.payoutStatus === "APPROVED" ? "APPROVED" : "PENDING"];
  const guidance = [
    { title: "Account details", points: ["Confirm your relationship to the property.", "Check your legal name and contact details.", "Submit the account profile for its own review."] },
    { title: "Property evidence", points: ["Find the address and confirm the map pin.", "Add rooms, bed spaces and approved photos.", "Submit the property for a separate decision."] },
    { title: "Identity and payout", points: ["Upload identity and ownership evidence.", "Choose a MoMo or bank destination.", "Identity unlocks listing work; payout approval unlocks booking."] },
  ];
  return <div className="hostel-onboarding">
    <div className="hostel-onboarding-heading"><div><p className="console-note">SAVE AND RESUME · {labels.length} STEPS</p><h2>Set up your hostel</h2><p>Each step receives its own decision. Identity approval unlocks listing work; an approved payout destination unlocks student booking.</p></div><Link href="/console/hostels">Save and exit</Link></div>
    <div className="hostel-onboarding-mobile-progress"><span>Step {activeStep + 1} of {labels.length}</span><strong>{labels[activeStep]}</strong><div role="progressbar" aria-valuenow={activeStep + 1} aria-valuemin={1} aria-valuemax={labels.length} aria-label="Setup progress"><span style={{ width: `${((activeStep + 1) / labels.length) * 100}%` }}/></div></div>
    <div className="hostel-onboarding-layout">
      <nav className="hostel-onboarding-steps" aria-label="Onboarding steps" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>{labels.map((label, index) => <button key={label} type="button" className={activeStep === index ? "is-current" : ""} aria-current={activeStep === index ? "step" : undefined} onClick={() => { setStep(index); setError(""); setNotice(""); }}><span>{index + 1}</span><strong>{label}</strong>{badge(states[index])}</button>)}</nav>
      <details className="hostel-onboarding-mobile-help"><summary>What this step needs</summary><ul>{guidance[activeStep].points.map(point => <li key={point}>{point}</li>)}</ul></details>
      <div className="hostel-onboarding-content">
        {error && <div className="console-alert" role="alert">{error}</div>}
        {notice && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
        {!owner && !error && <div className="console-panel">Loading your setup…</div>}
        {owner && step === 0 && <section className="console-panel"><h2><ShieldCheck size={18}/>Account and owner details</h2><p className="console-note">Your account is active, but these details receive a separate review. Only the owner can change payout details later.</p><div className="hostel-onboarding-readonly"><span><strong>Legal name</strong>{owner.name}</span><span><strong>Email</strong>{owner.email}</span><span><strong>Phone</strong>{owner.phone}</span></div>{owner.profileReason && <p className="console-reason">Needs changes: {owner.profileReason}</p>}<form className="console-form" onSubmit={saveProfile}><label>Your relationship to the property<select value={ownerRole} onChange={event => setOwnerRole(event.target.value)}><option value="OWNER">I own the property</option><option value="AUTHORIZED_MANAGER">I am authorized to manage it</option><option value="COMPANY_REPRESENTATIVE">I represent the owner company</option></select></label><label>Hostel or business name<input type="text" maxLength={120} value={organization} onChange={event => setOrganization(event.target.value)} placeholder="Optional for an individual owner" /></label><button disabled={Boolean(busy)}>{busy === "profile" ? "Saving…" : "Submit account details"}</button></form></section>}
        {owner && step === 1 && <><section className="console-panel"><h2><MapPin size={18}/>Property details</h2><p className="console-note">Search for the address, confirm the pin and add the building details. A location suggestion is not staff verification.</p>{properties.length > 0 && <label className="hostel-onboarding-selector">Property<select value={propertyId} onChange={event => { setPropertyId(event.target.value); void loadProperty(event.target.value).catch(cause => setError(cause instanceof Error ? cause.message : "Property could not load.")); }}><option value="">Create another property</option>{properties.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>}<form className="console-form" onSubmit={saveProperty}><label>Property name<input required maxLength={80} value={property.name} onChange={event => setProperty({ ...property, name: event.target.value })}/></label><label className="console-field-wide">Address<input required maxLength={160} value={property.address} onChange={event => { setProperty({ ...property, address: event.target.value }); setSuggestions([]); }} placeholder="Street, area, Tarkwa"/><button type="button" className="console-secondary" onClick={() => void findAddress()} disabled={searching || property.address.trim().length < 3}>{searching ? "Searching…" : "Find address"}</button></label>{suggestions.length > 0 && <div className="hostel-address-results console-field-wide" role="listbox">{suggestions.map(item => <button type="button" key={`${item.label}:${item.latitude}`} onClick={() => { setProperty({ ...property, address: item.label, latitude: String(item.latitude), longitude: String(item.longitude) }); setSuggestions([]); }}>{item.label}</button>)}</div>}<div className="console-field-wide"><HostelLocationPicker latitude={property.latitude} longitude={property.longitude} onChange={(latitude, longitude) => setProperty(current => ({ ...current, latitude, longitude }))}/></div><label>Latitude<input required inputMode="decimal" value={property.latitude} onChange={event => setProperty({ ...property, latitude: event.target.value })}/></label><label>Longitude<input required inputMode="decimal" value={property.longitude} onChange={event => setProperty({ ...property, longitude: event.target.value })}/></label><label>University affiliation<select value={property.claim} onChange={event => setProperty({ ...property, claim: event.target.value })}><option value="UNSURE">Unsure</option><option value="INDEPENDENT">Independent</option><option value="AFFILIATED">Claim UMaT affiliation</option></select></label><label>Affiliation evidence or explanation<input value={property.evidenceNote} onChange={event => setProperty({ ...property, evidenceNote: event.target.value })} maxLength={500} placeholder="Required for an affiliation claim"/></label><label className="console-check-field"><input type="checkbox" checked={property.utilitiesEnabled} onChange={event => setProperty({ ...property, utilitiesEnabled: event.target.checked })}/> Charge utilities per bed</label><button disabled={Boolean(busy)}>{busy === "property" ? "Saving…" : propertyId ? "Save property details" : "Create property draft"}</button></form></section>{propertyId && <><section className="console-panel"><h2>Rooms and beds</h2><p className="console-note">Add at least one room. Bed listings and yearly prices are created later in the workspace, after identity approval.</p>{rooms.length > 0 && <><p className="console-note">{rooms.length} rooms saved. The first eight are shown to keep setup short.</p><ul className="hostel-onboarding-rooms">{(showAllRooms ? rooms : rooms.slice(0, 8)).map(item => <li key={item.id}>{item.label}<span>{item.capacity} student bed {item.capacity === 1 ? "space" : "spaces"}{item.bedLayout === "BUNK" ? ` · ${item.capacity / 2} bunk unit${item.capacity === 2 ? "" : "s"}` : ""}</span></li>)}</ul>{rooms.length > 8 && <button type="button" className="hostel-onboarding-room-toggle" onClick={() => setShowAllRooms(value => !value)}>{showAllRooms ? "Show fewer rooms" : `Show all ${rooms.length} rooms`}</button>}</>}<div className="hostel-onboarding-batch"><HostelRoomBatch key={propertyId} propertyId={propertyId} propertyName={selected?.name || property.name} canPrice={owner.identityStatus === "VERIFIED"} roomTemplates={rooms} onComplete={async message => { await loadProperty(propertyId); setNotice(message); }}/><button type="button" className="hostel-onboarding-room-toggle" onClick={() => setSingleRoomOpen(value => !value)}>{singleRoomOpen ? "Hide single-room form" : "Add one room manually"}</button></div>{singleRoomOpen && <form className="console-form" onSubmit={addRoom}><label>Room name<input required maxLength={24} value={room.label} onChange={event => setRoom({ ...room, label: event.target.value })} placeholder="Room 1"/></label><label>Student bed spaces<select value={room.capacity} onChange={event => setRoom({ ...room, capacity: event.target.value })}>{[1,2,3,4,5,6].filter(n => room.bedLayout !== "BUNK" || n % 2 === 0).map(n => <option key={n}>{n}</option>)}</select></label><label>Bed arrangement<select value={room.bedLayout} onChange={event => setRoom({ ...room, bedLayout: event.target.value, capacity: event.target.value === "BUNK" && Number(room.capacity) % 2 ? String(Number(room.capacity) + 1) : room.capacity })}><option value="SEPARATE">Separate beds</option><option value="BUNK">Bunk beds</option></select></label><p className="console-note">One bunk unit has an upper and lower student bed space.</p><label>Utilities fee per bed (GH₵)<input inputMode="decimal" value={room.utilitiesFee} onChange={event => setRoom({ ...room, utilitiesFee: event.target.value })}/></label><label>Amenities<input maxLength={200} value={room.amenities} onChange={event => setRoom({ ...room, amenities: event.target.value })}/></label><button disabled={Boolean(busy)}>{busy === "room" ? "Saving…" : "Add room and beds"}</button></form>}</section><PropertyPhotos key={propertyId} propertyId={propertyId} propertyName={selected?.name || property.name} rooms={rooms.map(item => ({ id: item.id, label: item.label }))} onNotice={setNotice}/><section className="console-panel hostel-onboarding-submit"><div><h2>Send this property for review</h2><p className="console-note">Add the pin, a room and at least one photo. Staff approve photos and property details separately.</p>{selected && badge(selected.status)}{propertyReviewReason && <p className="console-reason">Needs changes: {propertyReviewReason}</p>}</div><button type="button" disabled={Boolean(busy) || selected?.status === "PENDING_REVIEW"} onClick={() => void submitProperty()}>{busy === "submit-property" ? "Submitting…" : "Submit property"}</button></section></>}</>}
        {owner && step === 2 && <>{identityDocumentsVisible && <section className="console-panel"><h2>Owner identity and authority</h2><p className="console-note">Upload one accepted identity document and proof that you own or may manage the property. Files stay private to you and authorized staff.</p>{badge(owner.identityStatus)}{owner.identityReason && <p className="console-reason">Needs changes: {owner.identityReason}</p>}<div className="hostel-onboarding-docs">{(["IDENTITY", "AUTHORITY"] as const).map(kind => <label key={kind}>{kind === "IDENTITY" ? "Identity document" : "Ownership or authorization evidence"}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => { const file = event.target.files?.[0]; void uploadDocument(kind, file); event.target.value = ""; }}/>{documents.filter(item => item.kind === kind).map(item => <a key={item.id} href={`/api/console/hostel/identity/${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">Uploaded {new Date(item.uploadedAt).toLocaleDateString("en-GB")} · view privately</a>)}</label>)}</div></section>}<section className="console-panel"><h2>Where should payouts go?</h2><p className="console-note">Choose MoMo or bank. Saving the destination starts a separate review. Students cannot book until it is approved.</p>{badge(owner.payoutStatus)}{payoutData?.unavailable && <p className="console-note">Payment destinations are temporarily unavailable. You can return to this step later.</p>}{owner.payoutReason && <p className="console-reason">Needs changes: {owner.payoutReason}</p>}{payoutData?.account?.ready && <p className="console-note">Saved: {payoutData.account.bankName} {payoutData.account.accountMasked}</p>}<form className="console-form" onSubmit={savePayout}><label>Payment method<select value={payout.method} onChange={event => setPayout({ ...payout, method: event.target.value, bankCode: "" })}><option value="MOMO">Mobile money</option><option value="BANK">Bank account</option></select></label><label>{payout.method === "MOMO" ? "Network" : "Bank"}<select required value={payout.bankCode} onChange={event => setPayout({ ...payout, bankCode: event.target.value })}><option value="">Choose…</option>{(payoutData?.destinations?.[payout.method as "BANK" | "MOMO"] || []).map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><label>Account holder name<input required value={payout.accountName} onChange={event => setPayout({ ...payout, accountName: event.target.value })}/></label><label>{payout.method === "MOMO" ? "Mobile money number" : "Account number"}<input required inputMode={payout.method === "MOMO" ? "tel" : "text"} value={payout.accountNumber} onChange={event => setPayout({ ...payout, accountNumber: event.target.value })}/></label><button disabled={Boolean(busy)}>{busy === "payout" ? "Saving…" : "Submit payout destination"}</button></form></section>{owner.identityStatus === "VERIFIED" && <div className="hostel-onboarding-ready"><CheckCircle size={23}/><div><strong>Listing workspace unlocked</strong><p>Create yearly bed listings in your workspace. Each listing needs its own review.</p></div><Link href="/console/hostels">Open workspace <ArrowRight size={17}/></Link></div>}</>}
        <div className="hostel-onboarding-footer"><button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft size={16}/> Back</button><span>Step {activeStep + 1} of {labels.length}</span>{activeStep < labels.length - 1 ? <button type="button" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16}/></button> : <Link href="/console/hostels">Save and exit</Link>}</div>
      </div>
      <aside className="hostel-onboarding-help" aria-label="Current step checklist"><span className="hostel-onboarding-help-kicker">YOUR CHECKLIST</span><h3>{guidance[activeStep].title}</h3><ul>{guidance[activeStep].points.map(point => <li key={point}>{point}</li>)}</ul><div><strong>Review stays separate</strong><p>Completing this form sends the relevant details for staff review. It does not approve another step.</p></div></aside>
    </div>
  </div>;
}
