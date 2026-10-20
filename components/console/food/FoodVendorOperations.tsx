"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, ShieldCheck, Warning } from "@/components/ui/MaterialIcon";
import "./food-console.css";

type Operations = {
  provider: { id: string; name: string; verifiedHours: string };
  operation: { pilotEnabled: boolean; serviceStatus: "OPEN" | "BUSY" | "CLOSED"; currentHours: string; availabilityNote: string; updatedAt: string };
  items: Array<{ id: string; name: string; available: boolean }>;
  audit: Array<{ action: string; actor: string; createdAt: string }>;
};

export function FoodVendorOperations() {
  const [data, setData] = useState<Operations | null>(null);
  const [status, setStatus] = useState<Operations["operation"]["serviceStatus"]>("CLOSED");
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [available, setAvailable] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/console/food/operations", { cache: "no-store" });
    const body = await response.json() as Operations & { error?: string };
    if (!response.ok) throw new Error(body.error || "Operational controls could not be loaded.");
    setData(body); setStatus(body.operation.serviceStatus); setHours(body.operation.currentHours); setNote(body.operation.availabilityNote); setAvailable(body.items.filter((item) => item.available).map((item) => item.id));
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Operational controls could not be loaded.")), 0); return () => clearTimeout(timer); }, [load]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/console/food/operations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceStatus: status, currentHours: hours, availabilityNote: note, availableItemIds: available }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Operational update could not be saved.");
      await load(); setMessage("Availability updated. The change was added to the audit history.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Operational update could not be saved."); }
    finally { setBusy(false); }
  }
  if (!data) return message ? <section className="console-card food-vendor-wait"><Warning size={22} /><div><h2>Operations unavailable</h2><p>{message}</p></div></section> : <section className="console-card"><p>Loading operational controls…</p></section>;
  return <section className="console-card food-operations-editor">
    <div className="food-section-heading"><div><h2>Today’s availability</h2><p>These are live operational details. Staff-controlled provider identity, address and prices remain locked.</p></div><span className={`food-status is-${status.toLowerCase()}`}>{status}</span></div>
    {!data.operation.pilotEnabled && <p className="console-alert"><ShieldCheck size={17} /> Staff has not admitted this provider to the controlled pilot. You can prepare details, but students cannot send new requests.</p>}
    <form onSubmit={save}>
      <div className="food-operation-fields">
        <label>Service status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="OPEN">Open</option><option value="BUSY">Busy — longer preparation</option><option value="CLOSED">Temporarily closed</option></select></label>
        <label>Current operating hours<input required maxLength={180} value={hours} onChange={(event) => setHours(event.target.value)} /></label>
        <label className="wide">Student-facing note<textarea required={status === "CLOSED"} rows={2} maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="For example: Closed for stock count; reopens at 2 PM." /></label>
      </div>
      <fieldset><legend>Items available now</legend><p>Clear an item when it cannot be prepared. Its verified name and price remain in the audit record.</p><div className="food-item-switches">{data.items.map((item) => <label key={item.id}><input type="checkbox" checked={available.includes(item.id)} onChange={(event) => setAvailable(event.target.checked ? [...available,item.id] : available.filter((id) => id !== item.id))} /><span>{item.name}</span></label>)}</div></fieldset>
      {message && <p className="food-operation-message" role="status">{message}</p>}
      <button className="food-operation-save" disabled={busy}>{busy ? "Saving…" : "Publish availability update"}</button>
    </form>
    {data.operation.updatedAt && <p className="food-operation-updated"><Clock size={15} /> Last operational update {new Date(data.operation.updatedAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}</p>}
    {data.audit.length > 0 && <details className="food-operation-audit"><summary>Recent audit history ({data.audit.length})</summary>{data.audit.map((entry, index) => <p key={`${entry.createdAt}-${index}`}><strong>{entry.action.replaceAll("_"," ")}</strong><span>{entry.actor} · {new Date(entry.createdAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}</span></p>)}</details>}
  </section>;
}
