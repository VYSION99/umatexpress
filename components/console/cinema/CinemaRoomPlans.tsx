"use client";

import { useCallback, useEffect, useState } from "react";
import "@/components/cinema/cinema.css";

type Grant = { account_id: string; email: string; plan: string; valid_until: string; reason: string; updated_at: string };
type Price = { plan: string; price_pesewas: number; enabled: number };
type Plans = Record<string, { label: string }>;

export function CinemaRoomPlans() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [plans, setPlans] = useState<Plans>({});
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [priceEnabled, setPriceEnabled] = useState<Record<string, boolean>>({});
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("STUDENT_PLUS");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/console/cinema/room-plans", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { grants?: Grant[]; prices?: Price[]; plans?: Plans; error?: string };
    if (!response.ok) throw new Error(data.error || "Room plans could not be loaded.");
    setGrants(data.grants || []);
    setPrices(data.prices || []);
    setPlans(data.plans || {});
    setPriceDrafts(Object.fromEntries((data.prices || []).map(item => [item.plan, (item.price_pesewas / 100).toFixed(2)])));
    setPriceEnabled(Object.fromEntries((data.prices || []).map(item => [item.plan, Boolean(item.enabled)])));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Room plans could not be loaded.")), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const save = async (politicsApproval?: "APPROVE" | "REVOKE") => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/console/cinema/room-plans", {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), plan, politicsApproval, validUntil: validUntil && politicsApproval !== "REVOKE" ? new Date(validUntil).toISOString() : "", reason }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The plan could not be saved.");
      setMessage(politicsApproval === "APPROVE" ? "Student Politics Plus checkout approved." : politicsApproval === "REVOKE" ? "Student Politics Plus checkout approval revoked." : "Plan saved. New rooms will use it. Existing rooms keep their allowance.");
      setEmail(""); setReason(""); setValidUntil("");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The plan could not be saved."); }
    finally { setBusy(false); }
  };
  const savePrice = async (pricePlan: string) => {
    const amount = Number(priceDrafts[pricePlan]);
    if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100)) || amount < 1 || amount > 10_000) { setMessage("Enter a price between GH₵1 and GH₵10,000."); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/console/cinema/room-plans", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ pricePlan, pricePesewas: Math.round(amount * 100), enabled: priceEnabled[pricePlan] || false }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Price could not be saved.");
      setMessage("Price saved. New checkouts now use this amount.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Price could not be saved."); }
    finally { setBusy(false); }
  };
  return <section className="console-card" aria-label="Cinema private room plans">
    <h2>Private room plans</h2>
    <p>Set prices and checkout availability for prepaid 30-day room plans.</p>
    <div className="cinema-admin-prices">{prices.map((item) => <div key={item.plan}><strong>{plans[item.plan]?.label || item.plan}</strong><label>Price per 30 days (GH₵)<input type="number" min="1" max="10000" step="0.01" value={priceDrafts[item.plan] ?? ""} onChange={(event) => setPriceDrafts(value => ({ ...value, [item.plan]: event.target.value }))} /></label><label className="cinema-admin-price-toggle"><input type="checkbox" checked={priceEnabled[item.plan] || false} onChange={(event) => setPriceEnabled(value => ({ ...value, [item.plan]: event.target.checked }))} /> Open checkout</label><button type="button" disabled={busy} onClick={() => void savePrice(item.plan)}>Save price</button></div>)}</div>
    <h3>Manual access and checkout approval</h3>
    <div className="console-form-grid">
      <label>Account email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="organizer@example.com" /></label>
      <label>Plan<select value={plan} onChange={(event) => setPlan(event.target.value)}>{Object.entries(plans).map(([code, policy]) => <option key={code} value={code}>{policy.label}</option>)}</select></label>
      <label>Valid until<input type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
      <label>Reason / payment reference<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} /></label>
    </div>
    <button type="button" disabled={busy || !plans[plan] || !email.trim() || !reason.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Assign plan"}</button>
    {plan === "STUDENT_POLITICS_PLUS" && <div>
      <p>Approve checkout after verifying the organizer’s role. Approval lets the student buy the plan. Assign plan grants access directly.</p>
      <button type="button" disabled={busy || !email.trim() || !reason.trim()} onClick={() => void save("APPROVE")}>Approve checkout</button>{" "}
      <button type="button" disabled={busy || !email.trim() || !reason.trim()} onClick={() => void save("REVOKE")}>Revoke checkout approval</button>
    </div>}
    {message && <p role="status">{message}</p>}
    {grants.length > 0 && <div className="console-table-wrap"><table className="console-table"><thead><tr><th>Account</th><th>Plan</th><th>Expires</th><th>Reason</th></tr></thead><tbody>{grants.map((grant) => <tr key={grant.account_id}><td>{grant.email || grant.account_id}</td><td>{plans[grant.plan]?.label || grant.plan}</td><td>{grant.valid_until ? new Date(grant.valid_until).toLocaleDateString() : "No expiry"}</td><td>{grant.reason}</td></tr>)}</tbody></table></div>}
  </section>;
}
