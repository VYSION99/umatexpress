"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
type Slot = { id: string; startsAt: string; endsAt: string; status: string; capacity: number; taken: number };
type RequestItem = { id: string; slotId: string; studentEmail: string; note: string; status: string; startsAt: string };
const when = (value: string) => new Date(value).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export function HostelViewingDesk({ propertyId }: { propertyId: string }) {
  const [slots, setSlots] = useState<Slot[]>([]); const [requests, setRequests] = useState<RequestItem[]>([]);
  const [start, setStart] = useState(""); const [end, setEnd] = useState(""); const [capacity, setCapacity] = useState(1);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/console/hostel/viewings?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Viewings could not load.");
    setSlots(data.slots || []); setRequests(data.requests || []);
  }, [propertyId]);
  useEffect(() => { queueMicrotask(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "Viewings could not load.")); }); }, [load]);
  async function send(method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(String(body.requestId || body.slotId || "create")); setError(""); setNotice("");
    try {
      const response = await fetch("/api/console/hostel/viewings", { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId, ...body }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Viewing could not be updated.");
      setSlots(data.slots || []); setRequests(data.requests || []); setNotice(method === "POST" ? "Viewing time published." : "Viewing updated.");
      if (method === "POST") { setStart(""); setEnd(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Viewing could not be updated."); }
    finally { setBusy(""); }
  }
  function create(event: FormEvent) { event.preventDefault(); const startsAt = new Date(start), endsAt = new Date(end); if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) { setError("Choose valid start and end times."); return; } void send("POST", { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), capacity }); }
  return <section className="console-panel"><h2>In-person viewings</h2><p className="console-note">Publish a time, then confirm or decline each student’s request. A request does not hold a bed.</p>
    {error && <p className="console-alert" role="alert">{error}</p>}{notice && <p className="console-note" role="status">{notice}</p>}
    <form className="console-form" onSubmit={create}><label>Starts<input type="datetime-local" required value={start} onChange={event => setStart(event.target.value)} /></label><label>Ends<input type="datetime-local" required value={end} onChange={event => setEnd(event.target.value)} /></label><label>Visitors<input type="number" min={1} max={10} value={capacity} onChange={event => setCapacity(Number(event.target.value))} /></label><button disabled={Boolean(busy)}>Publish time</button></form>
    {slots.length ? <ul className="console-gallery">{slots.map(slot => <li key={slot.id}><strong>{when(slot.startsAt)} · {slot.taken}/{slot.capacity} requested</strong><span>{slot.status}</span>{slot.status === "OPEN" && <button type="button" disabled={Boolean(busy)} onClick={() => void send("PATCH", { action: "CANCEL_SLOT", slotId: slot.id })}>Cancel time</button>}
      {requests.filter(item => item.slotId === slot.id).map(item => <div key={item.id}><strong>{item.studentEmail} · {item.status}</strong>{item.note && <p>{item.note}</p>}{item.status === "PENDING" && <div className="campus-button-row"><button type="button" disabled={Boolean(busy)} onClick={() => void send("PATCH", { action: "CONFIRM", requestId: item.id })}>Confirm</button><button type="button" disabled={Boolean(busy)} onClick={() => void send("PATCH", { action: "DECLINE", requestId: item.id })}>Decline</button></div>}</div>)}
    </li>)}</ul> : <p className="console-note">No viewing times posted for this property.</p>}
  </section>;
}
