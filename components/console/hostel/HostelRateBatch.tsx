"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CurrencyCircleDollar, X } from "@/components/ui/MaterialIcon";
import { SheetHandle } from "@/components/ui/SheetHandle";
import "@/components/console/hostel/room-batch.css";

type Period = { id: string; name: string };
const BATCH_SIZE = 20;
const toPesewas = (value: string) => Math.round(Number(value.replace(/,/g, "")) * 100);

export function HostelRateBatch({ propertyId, periods, onComplete }: { propertyId: string; periods: Period[]; onComplete: (message: string) => void | Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState("Room");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("100");
  const [periodId, setPeriodId] = useState("");
  const [price, setPrice] = useState("");
  const [processed, setProcessed] = useState(0);
  const [changed, setChanged] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const first = Number(start);
  const last = Number(end);
  const count = Number.isInteger(first) && Number.isInteger(last) && last >= first ? last - first + 1 : 0;
  const width = Math.min(4, Math.max(1, String(last).length));
  const label = (number: number) => `${prefix.trim()} ${String(number).padStart(width, "0")}`;
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open && dialog.current?.open) dialog.current.close(); }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!count || count > 100 || first < 1 || last > 9999) { setError("Choose 1 to 100 existing numbered rooms."); return; }
    if (!periodId || !price || !Number.isFinite(toPesewas(price))) { setError("Choose an academic year and a valid annual rent per bed."); return; }
    setBusy(true); setError("");
    let completed = processed;
    let bedsChanged = changed;
    try {
      for (let chunkStart = first + processed; chunkStart <= last; chunkStart += BATCH_SIZE) {
        const chunkEnd = Math.min(chunkStart + BATCH_SIZE - 1, last);
        const response = await fetch("/api/console/hostel/room-rates/batch", {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ propertyId, prefix: prefix.trim(), start: chunkStart, end: chunkEnd, width, periodId, price: toPesewas(price) }),
        });
        const data = await response.json() as { error?: string; result?: { changed: number } };
        if (!response.ok || !data.result) throw new Error(data.error || `Rooms ${chunkStart}–${chunkEnd} could not be priced.`);
        completed += chunkEnd - chunkStart + 1;
        bedsChanged += data.result.changed;
        setProcessed(completed); setChanged(bedsChanged);
      }
      setDone(true);
      await onComplete(`${completed} rooms checked; ${bedsChanged} bed listings created or repriced as drafts. Submit drafts for review.`);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Pricing stopped."} ${completed ? `${completed} rooms finished. Correct the issue and continue from ${label(first + completed)}.` : "Nothing in this range was changed."}`);
      if (completed) await onComplete(`${completed} rooms priced so far. Continue the range in the dialog.`);
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" className="hostel-batch-launch" onClick={() => setOpen(true)}><CurrencyCircleDollar size={17}/> Price an existing room range</button>
    <dialog ref={dialog} className="hostel-batch-dialog" aria-labelledby="hostel-rate-batch-title" onCancel={event => { if (busy) event.preventDefault(); else setOpen(false); }} onClick={event => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <SheetHandle onDismiss={() => setOpen(false)} disabled={busy} />
      <div className="hostel-batch-inner"><header><div><span>FAST RATE SETUP</span><h2 id="hostel-rate-batch-title">One rate for many rooms</h2><p>Existing numbered rooms · same annual rent per student bed</p></div><button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}><X size={20}/></button></header>
        {done ? <div className="hostel-batch-done" role="status"><strong>{processed} rooms checked</strong><p>{changed} bed listings created or repriced. Changed offers are drafts and still need staff review.</p><button type="button" onClick={() => setOpen(false)}>Done</button></div> : <form onSubmit={event => void submit(event)}>
          <div className="hostel-batch-fields">
            <label>Room prefix<input required maxLength={18} value={prefix} onChange={event => setPrefix(event.target.value)} disabled={busy || processed > 0}/></label>
            <label>First number<input required type="number" min={1} max={9999} value={start} onChange={event => setStart(event.target.value)} disabled={busy || processed > 0}/></label>
            <label>Last number<input required type="number" min={1} max={9999} value={end} onChange={event => setEnd(event.target.value)} disabled={busy || processed > 0}/></label>
            <label>Academic year<select required value={periodId} onChange={event => setPeriodId(event.target.value)} disabled={busy || processed > 0}><option value="">Choose a year</option>{periods.map(period => <option key={period.id} value={period.id}>{period.name}</option>)}</select></label>
            <label className="hostel-batch-wide">Annual rent per student bed (GH₵)<input required inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} placeholder="1800.00" disabled={busy || processed > 0}/></label>
          </div>
          <div className="hostel-batch-preview"><strong>{count > 0 && count <= 100 ? `${count} rooms` : "Choose up to 100 rooms"}</strong><span>{count > 0 && count <= 100 ? `${label(first)} → ${label(last)}` : "Numbered range preview"}</span><small>Each room keeps one equal price across its separate student beds. Already matching prices are skipped.</small></div>
          {processed > 0 && <div className="hostel-batch-progress" role="status"><div><span style={{ width: `${Math.min(100, processed / Math.max(count, 1) * 100)}%` }}/></div><p>{processed} of {count} rooms checked · {changed} bed listings changed</p></div>}
          {error && <p className="hostel-batch-error" role="alert">{error}</p>}
          <footer><button type="button" className="hostel-batch-cancel" disabled={busy} onClick={() => setOpen(false)}>Close</button><button type="submit" disabled={busy || count < 1 || count > 100}>{busy ? `Pricing… ${processed}/${count}` : processed ? `Continue from ${label(first + processed)}` : `Price ${count || ""} rooms`}</button></footer>
        </form>}
      </div>
    </dialog>
  </>;
}
