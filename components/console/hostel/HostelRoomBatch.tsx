"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { StackPlus, X } from "@phosphor-icons/react";
import "@/components/console/hostel/room-batch.css";

type Period = { id: string; name: string };
type RoomTemplate = { id: string; label: string; capacity: number; utilitiesFee: number; amenities: string; bedLayout: "SEPARATE" | "BUNK"; status?: string };
type Props = { propertyId: string; propertyName: string; canPrice: boolean; roomTemplates?: RoomTemplate[]; onComplete: (message: string) => void | Promise<void> };
const BATCH_SIZE = 20;
const MAX_RANGE = 100;
const toPesewas = (value: string) => Math.round(Number(value.replace(/,/g, "")) * 100);

export function HostelRoomBatch({ propertyId, propertyName, canPrice, roomTemplates = [], onComplete }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState("Room");
  const [templateId, setTemplateId] = useState("");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("100");
  const [capacity, setCapacity] = useState("2");
  const [bedLayout, setBedLayout] = useState<"SEPARATE" | "BUNK">("SEPARATE");
  const [utilitiesFee, setUtilitiesFee] = useState("0");
  const [amenities, setAmenities] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [price, setPrice] = useState("");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [nextStart, setNextStart] = useState<number | null>(null);
  const [processed, setProcessed] = useState(0);
  const [created, setCreated] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const first = Number(start);
  const last = Number(end);
  const count = Number.isInteger(first) && Number.isInteger(last) && last >= first ? last - first + 1 : 0;
  const width = Math.min(4, Math.max(1, String(last).length));
  const name = (number: number) => `${prefix.trim()} ${String(number).padStart(width, "0")}`;

  useEffect(() => {
    const node = dialog.current;
    if (open && !node?.open) node?.showModal();
    if (!open && node?.open) node.close();
  }, [open]);

  async function launch() {
    setOpen(true); setError("");
    if (!canPrice) return;
    try {
      const response = await fetch("/api/hostel/periods", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { periods?: Period[] };
      if (response.ok) setPeriods(data.periods || []);
    } catch { /* The range can still create rooms without rent. */ }
  }

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!count || count > MAX_RANGE || first < 1 || last > 9999 || !Number.isInteger(first) || !Number.isInteger(last)) {
      setError(`Choose 1 to ${MAX_RANGE} numbered rooms between 1 and 9999.`); return;
    }
    if (!prefix.trim() || name(last).length > 24) { setError("Keep the room prefix and number within 24 characters."); return; }
    if (periodId && (!price || !Number.isFinite(toPesewas(price)))) { setError("Enter the annual rent per student bed."); return; }
    const from = nextStart ?? first;
    setBusy(true); setError("");
    let made = created;
    let already = skipped;
    let progress = processed;
    try {
      for (let chunkStart = from; chunkStart <= last; chunkStart += BATCH_SIZE) {
        const chunkEnd = Math.min(chunkStart + BATCH_SIZE - 1, last);
        const response = await fetch("/api/console/hostel/rooms/batch", {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ propertyId, prefix: prefix.trim(), start: chunkStart, end: chunkEnd, width, capacity: Number(capacity), bedLayout, utilitiesFee: toPesewas(utilitiesFee), amenities, ...(periodId ? { periodId, price: toPesewas(price) } : {}) }),
        });
        const data = await response.json() as { error?: string; result?: { created: number; skipped: number } };
        if (!response.ok || !data.result) throw new Error(data.error || `Rooms ${chunkStart}–${chunkEnd} could not be saved.`);
        made += data.result.created; already += data.result.skipped; progress += chunkEnd - chunkStart + 1;
        setCreated(made); setSkipped(already); setProcessed(progress); setNextStart(chunkEnd + 1);
      }
      setDone(true);
      await onComplete(`${made} ${made === 1 ? "room" : "rooms"} created${already ? `, ${already} already present` : ""}. ${periodId ? "Every new bed has the shared annual rent in draft." : "Set annual rent when identity is approved."}`);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "The batch stopped."} ${progress ? `${progress} rooms were processed. Fix the issue, then continue from room ${nextStart ?? first + progress}.` : "No rooms were created in this batch."}`);
      if (progress) await onComplete(`${made} rooms created so far. Continue the remaining range in the batch dialog.`);
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" className="hostel-batch-launch" onClick={() => void launch()}><StackPlus size={17}/> Create a room range</button>
    <dialog ref={dialog} className="hostel-batch-dialog" aria-labelledby="hostel-batch-title" onCancel={event => { if (busy) event.preventDefault(); else setOpen(false); }} onClick={event => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <div className="hostel-batch-inner">
        <header><div><span>FAST ROOM SETUP</span><h2 id="hostel-batch-title">Create matching rooms</h2><p>{propertyName} · one template for a numbered range</p></div><button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}><X size={20}/></button></header>
        {done ? <div className="hostel-batch-done" role="status"><strong>{created} rooms created</strong><p>{skipped ? `${skipped} matching rooms were already present. ` : ""}Beds and optional rates are saved as drafts. Review the result before submitting listings.</p><button type="button" onClick={() => setOpen(false)}>Done</button></div> : <form onSubmit={event => void run(event)}>
          {roomTemplates.length > 0 && <label className="hostel-batch-template">Copy features from a room<select value={templateId} disabled={busy || processed > 0} onChange={event => { const id = event.target.value; setTemplateId(id); const room = roomTemplates.find(item => item.id === id); if (room) { setCapacity(String(room.capacity)); setBedLayout(room.bedLayout); setUtilitiesFee((room.utilitiesFee / 100).toFixed(2)); setAmenities(room.amenities); } }}><option value="">Start with defaults</option>{roomTemplates.filter(room => room.status !== "RETIRED").map(room => <option key={room.id} value={room.id}>{room.label} · {room.capacity} beds</option>)}</select></label>}
          <div className="hostel-batch-fields">
            <label>Room prefix<input required maxLength={18} value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="Room" disabled={busy || processed > 0}/></label>
            <label>First number<input required type="number" min={1} max={9999} value={start} onChange={event => setStart(event.target.value)} disabled={busy || processed > 0}/></label>
            <label>Last number<input required type="number" min={1} max={9999} value={end} onChange={event => setEnd(event.target.value)} disabled={busy || processed > 0}/></label>
            <label>Student beds per room<select value={capacity} onChange={event => setCapacity(event.target.value)} disabled={busy || processed > 0}>{[1,2,3,4,5,6].filter(number => bedLayout !== "BUNK" || number % 2 === 0).map(number => <option key={number}>{number}</option>)}</select></label>
            <label>Bed layout<select value={bedLayout} onChange={event => { const layout = event.target.value as "SEPARATE" | "BUNK"; setBedLayout(layout); if (layout === "BUNK" && Number(capacity) % 2) setCapacity(String(Number(capacity) + 1)); }} disabled={busy || processed > 0}><option value="SEPARATE">Separate beds</option><option value="BUNK">Bunk beds (upper + lower)</option></select></label>
            <label>Utilities per bed (GH₵)<input required inputMode="decimal" value={utilitiesFee} onChange={event => setUtilitiesFee(event.target.value)} disabled={busy || processed > 0}/></label>
            <label className="hostel-batch-wide">Shared amenities<input maxLength={200} value={amenities} onChange={event => setAmenities(event.target.value)} placeholder="Wardrobe, desk, private bath" disabled={busy || processed > 0}/></label>
          </div>
          {canPrice && <div className="hostel-batch-pricing"><strong>Optional: price every bed now</strong><p>The price is annual rent for one student bed. Each bed becomes a separate draft listing at the same price.</p><div className="hostel-batch-fields"><label>Academic year<select value={periodId} onChange={event => setPeriodId(event.target.value)} disabled={busy || processed > 0}><option value="">Price later</option>{periods.map(period => <option key={period.id} value={period.id}>{period.name}</option>)}</select></label>{periodId && <label>Annual rent per bed (GH₵)<input required inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} disabled={busy || processed > 0} placeholder="1800.00"/></label>}</div></div>}
          <div className="hostel-batch-preview"><strong>{count > 0 && count <= MAX_RANGE ? `${count} rooms · ${count * Number(capacity)} beds` : `Choose up to ${MAX_RANGE} rooms`}</strong><span>{count > 0 && count <= MAX_RANGE ? `${name(first)} → ${name(last)}` : "Numbered range preview"}</span><small>Saved in batches of {BATCH_SIZE}. Repeating the same range safely skips matching rooms.</small></div>
          {processed > 0 && <div className="hostel-batch-progress" role="status"><div><span style={{ width: `${Math.min(100, processed / Math.max(count,1) * 100)}%` }}/></div><p>{processed} of {count} rooms processed · {created} created · {skipped} already present</p></div>}
          {error && <p className="hostel-batch-error" role="alert">{error}</p>}
          <footer><button type="button" className="hostel-batch-cancel" disabled={busy} onClick={() => setOpen(false)}>Close</button><button type="submit" disabled={busy || count < 1 || count > MAX_RANGE}>{busy ? `Saving batch… ${processed}/${count}` : processed ? `Continue from room ${nextStart}` : `Create ${count || ""} rooms`}</button></footer>
        </form>}
      </div>
    </dialog>
  </>;
}
