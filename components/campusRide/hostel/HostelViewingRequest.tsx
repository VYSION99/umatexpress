"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";

type Slot = { id: string; startsAt: string; endsAt: string; capacity: number; taken: number; status: string; myStatus: string; myRequestId: string };
const when = (value: string) => new Date(value).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export function HostelViewingRequest({ propertyId }: { propertyId: string }) {
  const { ready, account } = useStudentAccount();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/hostel/viewings?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Viewing times could not load.");
    setSlots(data.slots || []);
  }, [propertyId]);
  useEffect(() => { queueMicrotask(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "Viewing times could not load.")); }); }, [load, account]);
  async function act(method: "POST" | "DELETE", slot: Slot) {
    setBusy(slot.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/hostel/viewings", { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(method === "POST" ? { propertyId, slotId: slot.id, note } : { requestId: slot.myRequestId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The viewing could not be updated.");
      setNotice(method === "POST" ? "Request sent. The landlord will confirm or decline your visit." : "Your viewing request was cancelled.");
      setNote(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The viewing could not be updated."); }
    finally { setBusy(""); }
  }
  return <section className="hostel-viewings" aria-label="Visit this hostel">
    <h2>Visit before you book</h2><p>Ask to see the property in person. A request is free and does not reserve a bed.</p>
    {error && <p role="alert" className="hostel-choice-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {slots.length ? <><label>Note to the landlord (optional)<input value={note} maxLength={300} onChange={event => setNote(event.target.value)} placeholder="I would like to see a room and the utilities." /></label><ul>{slots.map(slot => <li key={slot.id}>
      <div><strong>{when(slot.startsAt)}</strong><small>{slot.myStatus ? `Your request: ${slot.myStatus.toLowerCase()}` : slot.status === "OPEN" ? `${Math.max(0, slot.capacity - slot.taken)} visit ${slot.capacity - slot.taken === 1 ? "place" : "places"} left` : "Closed"}</small></div>
      {slot.myStatus === "PENDING" || slot.myStatus === "CONFIRMED" ? <button type="button" disabled={busy === slot.id} onClick={() => void act("DELETE", slot)}>Cancel request</button> : slot.myStatus === "DECLINED" ? <span>Request declined</span> : slot.status !== "OPEN" || slot.taken >= slot.capacity ? <span>Full</span> : !ready ? <span>Checking account…</span> : !account ? <Link href={`/account?next=${encodeURIComponent(`/hostel/${propertyId}`)}`}>Sign in to request</Link> : <button type="button" disabled={busy === slot.id} onClick={() => void act("POST", slot)}>{busy === slot.id ? "Sending…" : "Request visit"}</button>}
    </li>)}</ul></> : <p>No viewing times have been posted yet. You can still ask a question about the property below.</p>}
  </section>;
}
