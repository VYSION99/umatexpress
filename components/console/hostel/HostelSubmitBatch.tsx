"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PaperPlaneTilt, X } from "@phosphor-icons/react";
import "@/components/console/hostel/room-batch.css";
type Period = { id: string; name: string };
export function HostelSubmitBatch({ propertyId, periods, onComplete }: { propertyId: string; periods: Period[]; onComplete: (message: string) => void | Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [prefix, setPrefix] = useState("Room"), [start, setStart] = useState("1"), [end, setEnd] = useState("100"), [periodId, setPeriodId] = useState("");
  const [processed, setProcessed] = useState(0), [submitted, setSubmitted] = useState(0), [error, setError] = useState("");
  const first = Number(start), last = Number(end), count = Number.isInteger(first) && Number.isInteger(last) && last >= first ? last - first + 1 : 0;
  const width = Math.min(4, Math.max(1, String(last).length));
  useEffect(() => { if (open && !ref.current?.open) ref.current?.showModal(); if (!open && ref.current?.open) ref.current.close(); }, [open]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!count || count > 100 || first < 1 || last > 9999 || !periodId) { setError("Choose up to 100 numbered rooms and an academic year."); return; }
    setBusy(true); setError("");
    let completed = processed, sent = submitted;
    try {
      for (let number = first + processed; number <= last; number += 20) {
        const through = Math.min(number + 19, last);
        const response = await fetch("/api/console/hostel/room-submissions/batch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, prefix, start: number, end: through, width, periodId }) });
        const data = await response.json() as { error?: string; result?: { submitted: number } };
        if (!response.ok || !data.result) throw new Error(data.error || "Submission failed.");
        completed += through - number + 1; sent += data.result.submitted;
        setProcessed(completed); setSubmitted(sent);
      }
      setDone(true); await onComplete(`${sent} beds submitted for review across ${completed} rooms.`);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Submission stopped."} ${completed} rooms completed. Fix the issue and continue.`);
      if (completed) await onComplete(`${sent} beds submitted so far.`);
    } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="hostel-batch-launch" onClick={() => setOpen(true)}><PaperPlaneTilt size={17}/> Submit a room range</button>
    <dialog ref={ref} className="hostel-batch-dialog" aria-labelledby="hostel-submit-batch-title" onCancel={event => { if (busy) event.preventDefault(); else setOpen(false); }} onClick={event => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <div className="hostel-batch-inner"><header><div><span>FAST REVIEW SETUP</span><h2 id="hostel-submit-batch-title">Submit beds together</h2><p>Priced drafts across numbered rooms</p></div><button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}><X size={20}/></button></header>
      {done ? <div className="hostel-batch-done" role="status"><strong>{submitted} beds submitted</strong><p>{processed} rooms checked. Existing live and pending beds were skipped.</p><button type="button" onClick={() => setOpen(false)}>Done</button></div> : <form onSubmit={event => void send(event)}>
        <div className="hostel-batch-fields">
          <label>Room prefix<input required maxLength={18} value={prefix} onChange={event => setPrefix(event.target.value)} disabled={busy || processed > 0}/></label>
          <label>First number<input required type="number" min={1} max={9999} value={start} onChange={event => setStart(event.target.value)} disabled={busy || processed > 0}/></label>
          <label>Last number<input required type="number" min={1} max={9999} value={end} onChange={event => setEnd(event.target.value)} disabled={busy || processed > 0}/></label>
          <label>Academic year<select required value={periodId} onChange={event => setPeriodId(event.target.value)} disabled={busy || processed > 0}><option value="">Choose a year</option>{periods.map(period => <option key={period.id} value={period.id}>{period.name}</option>)}</select></label>
        </div>
        <div className="hostel-batch-preview"><strong>{count > 0 && count <= 100 ? `${count} rooms` : "Choose up to 100 rooms"}</strong><span>{prefix} {String(first).padStart(width, "0")} → {prefix} {String(last).padStart(width, "0")}</span><small>Owner and property approval are required. All available beds must already be priced. Each group of 20 rooms is checked before submission.</small></div>
        {processed > 0 && <div className="hostel-batch-progress" role="status"><div><span style={{ width: `${Math.min(100, processed / Math.max(count, 1) * 100)}%` }}/></div><p>{processed} of {count} rooms checked · {submitted} beds submitted</p></div>}
        {error && <p className="hostel-batch-error" role="alert">{error}</p>}
        <footer><button type="button" className="hostel-batch-cancel" disabled={busy} onClick={() => setOpen(false)}>Close</button><button type="submit" disabled={busy || count < 1 || count > 100}>{busy ? "Submitting…" : processed ? "Continue submission" : "Submit for review"}</button></footer>
      </form>}</div>
    </dialog>
  </>;
}
