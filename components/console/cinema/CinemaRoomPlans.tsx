"use client";

import { useCallback, useEffect, useState } from "react";
import "@/components/cinema/cinema.css";
import "./CinemaRoomPlans.css";

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
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
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
    const timer = setTimeout(() => void load().catch((error) => { setMessageKind("error"); setMessage(error instanceof Error ? error.message : "Room plans could not be loaded."); }), 0);
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
      setMessageKind("success");
      setMessage(politicsApproval === "APPROVE" ? "Student Politics Plus checkout approved." : politicsApproval === "REVOKE" ? "Student Politics Plus checkout approval revoked." : "Plan saved. New rooms will use it. Existing rooms keep their allowance.");
      setEmail(""); setReason(""); setValidUntil("");
      await load();
    } catch (error) { setMessageKind("error"); setMessage(error instanceof Error ? error.message : "The plan could not be saved."); }
    finally { setBusy(false); }
  };
  const savePrice = async (pricePlan: string) => {
    const amount = Number(priceDrafts[pricePlan]);
    if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100)) || amount < 1 || amount > 10_000) { setMessageKind("error"); setMessage("Enter a price between GH₵1 and GH₵10,000."); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/console/cinema/room-plans", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ pricePlan, pricePesewas: Math.round(amount * 100), enabled: priceEnabled[pricePlan] || false }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Price could not be saved.");
      setMessageKind("success");
      setMessage("Price saved. New checkouts now use this amount.");
      await load();
    } catch (error) { setMessageKind("error"); setMessage(error instanceof Error ? error.message : "Price could not be saved."); }
    finally { setBusy(false); }
  };
  return <section className="console-card cinema-room-plans" aria-labelledby="cinema-room-plans-title">
    <header className="cinema-room-plans-heading">
      <div>
        <p className="cinema-room-plans-eyebrow">ROOM ACCESS</p>
        <h2 id="cinema-room-plans-title">Private room plans</h2>
        <p>Set the 30-day price and checkout availability for each plan.</p>
      </div>
    </header>

    <div className="cinema-admin-prices" aria-label="Plan prices">
      {prices.map((item) => <form className="cinema-room-price-card" key={item.plan} onSubmit={(event) => { event.preventDefault(); void savePrice(item.plan); }}>
        <h3>{plans[item.plan]?.label || item.plan}</h3>
        <label className="cinema-room-field">Price per 30 days (GH₵)
          <input type="number" min="1" max="10000" step="0.01" inputMode="decimal" required value={priceDrafts[item.plan] ?? ""} onChange={(event) => setPriceDrafts(value => ({ ...value, [item.plan]: event.target.value }))} />
        </label>
        <label className="cinema-admin-price-toggle"><input type="checkbox" checked={priceEnabled[item.plan] || false} onChange={(event) => setPriceEnabled(value => ({ ...value, [item.plan]: event.target.checked }))} /><span>Open checkout</span></label>
        <button type="submit" disabled={busy}>Save plan settings</button>
      </form>)}
    </div>

    <section className="cinema-room-plans-manual" aria-labelledby="cinema-room-plans-manual-title">
      <div className="cinema-room-plans-section-heading">
        <h3 id="cinema-room-plans-manual-title">Manual access</h3>
        <p>Assign a plan to an account or approve its checkout.</p>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="cinema-room-plans-fields">
          <label className="cinema-room-field">Account email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
          <label className="cinema-room-field">Plan<select value={plan} onChange={(event) => setPlan(event.target.value)}>{Object.entries(plans).map(([code, policy]) => <option key={code} value={code}>{policy.label}</option>)}</select></label>
          <label className="cinema-room-field"><span>Valid until <small>Optional</small></span><input type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
          <label className="cinema-room-field">Reason or payment reference<input required value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} /></label>
        </div>
        <div className="cinema-room-plans-actions">
          <button className="cinema-room-plans-primary" type="submit" disabled={busy || !plans[plan] || !email.trim() || !reason.trim()}>{busy ? "Saving…" : "Assign plan"}</button>
        </div>
        {plan === "STUDENT_POLITICS_PLUS" && <div className="cinema-room-plans-approval">
          <p>After verifying the organizer’s role, approve checkout to let them purchase this plan. Assigning a plan grants access immediately.</p>
          <div>
            <button type="button" disabled={busy || !email.trim() || !reason.trim()} onClick={() => void save("APPROVE")}>Approve checkout</button>
            <button type="button" className="cinema-room-plans-danger" disabled={busy || !email.trim() || !reason.trim()} onClick={() => void save("REVOKE")}>Revoke approval</button>
          </div>
        </div>}
      </form>
    </section>

    {message && <p className={`cinema-room-plans-message is-${messageKind}`} role={messageKind === "error" ? "alert" : "status"}>{message}</p>}
    {grants.length > 0 && <section className="cinema-room-plans-grants" aria-labelledby="cinema-room-plans-grants-title">
      <div className="cinema-room-plans-section-heading"><h3 id="cinema-room-plans-grants-title">Assigned access</h3><p>{grants.length} {grants.length === 1 ? "account" : "accounts"}</p></div>
      <div className="cinema-room-plans-table-wrap"><table className="console-table cinema-room-plans-table"><thead><tr><th>Account</th><th>Plan</th><th>Expires</th><th>Reason</th></tr></thead><tbody>{grants.map((grant) => <tr key={grant.account_id}><td data-label="Account">{grant.email || grant.account_id}</td><td data-label="Plan">{plans[grant.plan]?.label || grant.plan}</td><td data-label="Expires">{grant.valid_until ? new Date(grant.valid_until).toLocaleDateString() : "No expiry"}</td><td data-label="Reason">{grant.reason}</td></tr>)}</tbody></table></div>
    </section>}
  </section>;
}
