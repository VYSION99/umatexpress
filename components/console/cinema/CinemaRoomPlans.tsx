"use client";

import { useCallback, useEffect, useState } from "react";

type Grant = { account_id: string; email: string; plan: string; valid_until: string; reason: string; updated_at: string };

export function CinemaRoomPlans() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("STUDENT_PLUS");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/console/cinema/room-plans", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { grants?: Grant[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Room plans could not be loaded.");
    setGrants(data.grants || []);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Room plans could not be loaded.")), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/console/cinema/room-plans", {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), plan, validUntil: validUntil ? new Date(validUntil).toISOString() : "", reason }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The plan could not be saved.");
      setMessage("Plan saved. New rooms will use it; existing rooms keep their allowance.");
      setEmail(""); setReason(""); setValidUntil("");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The plan could not be saved."); }
    finally { setBusy(false); }
  };
  return <section className="console-card" aria-label="Cinema private room plans">
    <h2>Private room plans</h2>
    <p>Free: 1 file / 500 MB / 60 minutes. Student Plus: 3 files / 2 GB / 3 hours. Club or Department Pro: 5 files / 5 GB / 5 hours. Assign paid tiers only after payment or an approved institutional agreement.</p>
    <div className="console-form-grid">
      <label>Account email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="organizer@example.com" /></label>
      <label>Plan<select value={plan} onChange={(event) => setPlan(event.target.value)}><option value="FREE">Free</option><option value="STUDENT_PLUS">Student Plus</option><option value="ORGANIZER_PRO">Club / Department Pro</option></select></label>
      <label>Valid until<input type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
      <label>Reason / payment reference<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} /></label>
    </div>
    <button type="button" disabled={busy || !email.trim() || !reason.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Assign plan"}</button>
    {message && <p role="status">{message}</p>}
    {grants.length > 0 && <div className="console-table-wrap"><table className="console-table"><thead><tr><th>Account</th><th>Plan</th><th>Expires</th><th>Reason</th></tr></thead><tbody>{grants.map((grant) => <tr key={grant.account_id}><td>{grant.email || grant.account_id}</td><td>{grant.plan.replaceAll("_", " ")}</td><td>{grant.valid_until ? new Date(grant.valid_until).toLocaleDateString() : "No expiry"}</td><td>{grant.reason}</td></tr>)}</tbody></table></div>}
  </section>;
}
