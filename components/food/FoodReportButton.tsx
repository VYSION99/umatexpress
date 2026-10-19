"use client";

import { useRef, useState } from "react";
import { Flag } from "@/components/ui/MaterialIcon";

export function FoodReportButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState("MENU");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setStatus("");
    try {
      const response = await fetch("/api/food/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, category, message }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The correction could not be sent.");
      setMessage(""); setStatus("Thank you. Staff will check this listing.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "The correction could not be sent."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="food-report-trigger" onClick={() => dialog.current?.showModal()}><Flag size={16} aria-hidden /> Report incorrect information</button>
    <dialog ref={dialog} className="food-report-dialog" onClose={() => setStatus("")}>
      <form onSubmit={submit}>
        <div className="food-report-heading"><div><span>LISTING CORRECTION</span><h3>{providerName}</h3></div><button type="button" aria-label="Close correction form" onClick={() => dialog.current?.close()}>×</button></div>
        <label>What needs checking?<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="MENU">Menu information</option><option value="PRICE">Price</option><option value="HOURS">Opening hours</option><option value="LOCATION">Location</option><option value="CONTACT">Contact details</option><option value="OTHER">Something else</option></select></label>
        <label>What did you notice?<textarea required minLength={10} maxLength={600} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Tell staff what appears to be out of date." /></label>
        {status && <p className="food-report-status" role="status">{status}</p>}
        <button className="food-report-submit" disabled={busy || message.trim().length < 10}>{busy ? "Sending…" : "Send correction"}</button>
      </form>
    </dialog>
  </>;
}
