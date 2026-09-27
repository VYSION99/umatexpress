"use client";

import { useCallback, useEffect, useState } from "react";

type Property = { id: string; name: string; status: string };
type RecordItem = { id: string; propertyId: string; kind: string; status: string; note: string; reviewedBy: string; reviewedAt: string };
const kinds = [{ id: "LOCATION", label: "Location pin and address" }, { id: "UTILITIES", label: "Utilities and room fees" }, { id: "SAFETY", label: "Safety details observed" }];
export function PropertyVerificationReview() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [kind, setKind] = useState("LOCATION");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/console/hostel/verifications", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Verification records could not load.");
    setProperties(data.properties || []); setRecords(data.records || []);
  }, []);
  useEffect(() => { queueMicrotask(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "Could not load checks.")); }); }, [load]);
  async function submit(action: "CHECK" | "REVOKE") { setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/hostel/verifications", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId, kind, note, action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The check could not be recorded.");
      setNotice(action === "CHECK" ? "Check recorded. Students will see it while the checked details remain current." : "Check revoked and removed from the student page.");
      setNote(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The check could not be recorded."); }
    finally { setBusy(false); }
  }
  const latest = records.filter(item => item.propertyId === propertyId).filter((item, index, list) => list.findIndex(other => other.kind === item.kind) === index);
  return <section className="console-panel">
    <h2>Property details checked by staff</h2>
    <p className="console-note">Record only what you inspected. A changed location, utility fee or property detail removes the public check until reviewed again. Photo checks come from photo approvals.</p>
    {error && <p className="console-alert" role="alert">{error}</p>}{notice && <p className="console-note" role="status">{notice}</p>}
    <form className="console-form" onSubmit={event => { event.preventDefault(); void submit("CHECK"); }}>
      <label>Property<select required value={propertyId} onChange={event => setPropertyId(event.target.value)}><option value="">Choose property</option>{properties.map(item => <option value={item.id} key={item.id}>{item.name} · {item.status}</option>)}</select></label>
      <label>What was checked<select value={kind} onChange={event => setKind(event.target.value)}>{kinds.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
      <label>Public review note<textarea required minLength={20} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="Describe what you saw and when, without promising more than was checked." /></label>
      <div className="campus-button-row"><button type="submit" disabled={busy || !propertyId || note.trim().length < 20}>Record check</button><button type="button" disabled={busy || !propertyId || note.trim().length < 20} onClick={() => void submit("REVOKE")}>Revoke check</button></div>
    </form>
    {latest.length > 0 && <ul className="console-gallery">{latest.map(item => <li key={item.id}><strong>{item.kind} · {item.status}</strong><small>{new Date(item.reviewedAt).toLocaleDateString("en-GB")} · {item.reviewedBy}</small><p>{item.note}</p></li>)}</ul>}
  </section>;
}
