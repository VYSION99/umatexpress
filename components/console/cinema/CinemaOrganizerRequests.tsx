"use client";

import { useCallback, useEffect, useState } from "react";

type Request = { id: string; name: string; organizer_type: string; description: string; owner_email: string; created_at: string };

export function CinemaOrganizerRequests() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const response = await fetch("/api/console/cinema/organizers", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { organizers?: Request[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Organizer requests could not be loaded.");
    setRequests(data.organizers || []);
  }, []);
  useEffect(() => { void load().catch((problem) => setError(problem instanceof Error ? problem.message : "Organizer requests could not be loaded.")); }, [load]);
  const decide = async (item: Request, approve: boolean) => {
    setBusy(item.id); setError("");
    try {
      const response = await fetch("/api/console/cinema/organizers", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, approve, verificationNote: notes[item.id] || "" }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Decision could not be saved.");
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Decision could not be saved."); }
    finally { setBusy(""); }
  };
  return <section className="console-card" aria-label="Cinema organizer approvals">
    <h2>Organizer approvals</h2>
    <p>Confirm that the student is authorized to represent the named club or department before approving.</p>
    {error && <p role="alert">{error}</p>}
    {requests.length === 0 ? <p>No requests waiting for review.</p> : <div className="console-table-wrap"><table className="console-table"><thead><tr><th>Organizer</th><th>Requested by</th><th>Affiliation and decision</th></tr></thead><tbody>{requests.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><br />{item.organizer_type}</td><td>{item.owner_email}</td><td><p>{item.description || "No affiliation information was supplied. Request it before approving."}</p><label>Verification source or rejection reason<textarea rows={2} maxLength={500} value={notes[item.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Record who or what confirmed this affiliation" /></label><div><button type="button" disabled={busy === item.id || (notes[item.id] || "").trim().length < 10 || !item.description} onClick={() => void decide(item, true)}>Approve</button> <button type="button" disabled={busy === item.id || (notes[item.id] || "").trim().length < 10} onClick={() => void decide(item, false)}>Reject</button></div></td></tr>)}</tbody></table></div>}
  </section>;
}
