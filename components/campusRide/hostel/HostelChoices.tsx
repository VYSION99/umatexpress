"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import { bedsLabel, cedis, distanceLabel } from "./format";
import type { PublicProperty } from "@/lib/hostel-engine/listings";

type Saved = { id: string; propertyId: string; periodId: string; name: string; periodName: string; alertEnabled: boolean; available: boolean };
type Choice = { id: string; name: string };
type State = {
  periodId: string; signedIn: boolean; ready: boolean; saved: Saved[]; selected: Choice[];
  busy: string; error: string; toggleSave: (choice: Choice) => Promise<void>; removeSaved: (choice: Choice, periodId: string) => Promise<void>;
  toggleAlert: (choice: Choice) => Promise<void>; toggleCompare: (choice: Choice) => void;
};
const Context = createContext<State | null>(null);
const MAX_COMPARE = 4;

function useChoices() {
  const value = useContext(Context);
  if (!value) throw new Error("Hostel choices require a provider");
  return value;
}

export function HostelChoicesProvider({ periodId, children }: { periodId: string; children: ReactNode }) {
  const { ready, account } = useStudentAccount();
  const [savedState, setSavedState] = useState<{ email: string; items: Saved[] }>({ email: "", items: [] });
  const saved = account && savedState.email === account.email ? savedState.items : [];
  const [selected, setSelected] = useState<Choice[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = JSON.parse(localStorage.getItem(`hostel-compare:${periodId}`) || "[]") as unknown;
        if (Array.isArray(stored)) setSelected(stored.filter((item): item is Choice => typeof item?.id === "string" && typeof item?.name === "string").slice(0, MAX_COMPARE));
      } catch { setSelected([]); }
    });
    return () => { active = false; };
  }, [periodId]);
  useEffect(() => {
    if (!ready || !account) return;
    let active = true;
    fetch("/api/hostel/saved", { credentials: "same-origin", cache: "no-store" })
      .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || "Saved hostels could not load."); return result; })
      .then(result => { if (active) setSavedState({ email: account.email, items: result.saved || [] }); })
      .catch(() => { if (active) setError("Saved hostels could not load. Refresh to try again."); });
    return () => { active = false; };
  }, [ready, account]);
  async function mutate(method: "POST" | "PATCH" | "DELETE", choice: Choice, enabled?: boolean, targetPeriodId = periodId) {
    setBusy(choice.id); setError("");
    try {
      const response = await fetch("/api/hostel/saved", {
        method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: choice.id, periodId: targetPeriodId, ...(enabled === undefined ? {} : { enabled }) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || result.message || "Could not update this hostel.");
      setSavedState({ email: account?.email || "", items: result.saved || [] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this hostel."); }
    finally { setBusy(""); }
  }
  const value = useMemo<State>(() => ({
    periodId, ready, signedIn: Boolean(account), saved, selected, busy, error,
    toggleSave: async choice => mutate(saved.some(item => item.propertyId === choice.id && item.periodId === periodId) ? "DELETE" : "POST", choice),
    removeSaved: async (choice, savedPeriodId) => mutate("DELETE", choice, undefined, savedPeriodId),
    toggleAlert: async choice => {
      const item = saved.find(entry => entry.propertyId === choice.id && entry.periodId === periodId);
      if (item) await mutate("PATCH", choice, !item.alertEnabled);
    },
    toggleCompare: choice => {
      setError("");
      setSelected(current => {
        const next = current.some(item => item.id === choice.id) ? current.filter(item => item.id !== choice.id) : current.length < MAX_COMPARE ? [...current, choice] : current;
        if (current.length === MAX_COMPARE && next === current) setError("Compare up to four hostels at a time.");
        try { localStorage.setItem(`hostel-compare:${periodId}`, JSON.stringify(next)); } catch { /* private browsing */ }
        return next;
      });
    },
  // Mutations use the current render's saved state and account.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [periodId, ready, account, saved, selected, busy, error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function HostelChoiceActions({ propertyId, propertyName }: { propertyId: string; propertyName: string }) {
  const state = useChoices();
  const choice = { id: propertyId, name: propertyName };
  const saved = state.saved.find(item => item.propertyId === propertyId && item.periodId === state.periodId);
  const compared = state.selected.some(item => item.id === propertyId);
  return <div className="hostel-choice-actions">
    {state.ready && (state.signedIn ? <button type="button" disabled={state.busy === propertyId} aria-pressed={Boolean(saved)} onClick={() => void state.toggleSave(choice)}>{saved ? "Saved ✓" : "♡ Save"}</button> : <Link href={`/account?next=${encodeURIComponent(`/hostel/${propertyId}?periodId=${state.periodId}`)}`}>♡ Save</Link>)}
    <button type="button" aria-pressed={compared} onClick={() => state.toggleCompare(choice)}>{compared ? "✓ Comparing" : "＋ Compare"}</button>
    {saved && <button type="button" disabled={state.busy === propertyId} aria-pressed={saved.alertEnabled} onClick={() => void state.toggleAlert(choice)}>{saved.alertEnabled ? "Alerts on" : "Notify me"}</button>}
  </div>;
}

export function HostelChoicesPanel() {
  const state = useChoices();
  const [showSaved, setShowSaved] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [compared, setCompared] = useState<PublicProperty[]>([]);
  const [loading, setLoading] = useState(false);
  const [compareError, setCompareError] = useState("");
  async function openCompare() {
    if (!state.selected.length) return;
    setLoading(true); setCompareError(""); setShowCompare(true);
    try {
      const query = new URLSearchParams({ periodId: state.periodId, ids: state.selected.map(item => item.id).join(","), pageSize: "4" });
      const response = await fetch(`/api/hostel/properties?${query}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Comparison could not load.");
      setCompared(result.properties || []);
    } catch (cause) { setCompareError(cause instanceof Error ? cause.message : "Comparison could not load."); }
    finally { setLoading(false); }
  }
  const ordered = state.selected.map(item => compared.find(property => property.id === item.id));
  return <section className="hostel-choices" aria-label="Saved and compared hostels">
    <div className="hostel-choices-bar">
      {state.signedIn && <button type="button" aria-expanded={showSaved} onClick={() => setShowSaved(value => !value)}>Saved hostels <span>{state.saved.length}</span></button>}
      <button type="button" disabled={!state.selected.length} onClick={() => void openCompare()}>Compare <span>{state.selected.length}/{MAX_COMPARE}</span></button>
      {state.selected.length > 0 && <span className="hostel-choices-hint">Select up to four hostels, even across result pages.</span>}
    </div>
    {state.error && <p className="hostel-choice-error" role="alert">{state.error}</p>}
    {showSaved && <div className="hostel-saved-panel">
      <h2>Your saved hostels</h2>
      <p>Keep your shortlist here. Turn on alerts for beds that become free and new academic years that open.</p>
      {state.saved.length ? <ul>{state.saved.map(item => <li key={item.id}>
        <div><Link href={`/hostel/${encodeURIComponent(item.propertyId)}?periodId=${encodeURIComponent(item.periodId)}`}>{item.name}</Link><small>{item.periodName} · {item.available ? "Beds available" : "No beds currently available"}</small></div>
        <div className="hostel-choice-actions">{item.periodId === state.periodId && <><button type="button" onClick={() => state.toggleCompare({ id: item.propertyId, name: item.name })}>{state.selected.some(choice => choice.id === item.propertyId) ? "Remove comparison" : "Compare"}</button><button type="button" disabled={state.busy === item.propertyId} aria-pressed={item.alertEnabled} onClick={() => void state.toggleAlert({ id: item.propertyId, name: item.name })}>{item.alertEnabled ? "Alerts on" : "Notify me"}</button></>}<button type="button" disabled={state.busy === item.propertyId} onClick={() => void state.removeSaved({ id: item.propertyId, name: item.name }, item.periodId)} aria-label={`Remove ${item.name} from saved hostels`}>Remove</button></div>
      </li>)}</ul> : <p>No saved hostels yet. Use “Save” on a hostel card to build your shortlist.</p>}
    </div>}
    {showCompare && <div className="hostel-compare-panel">
      <div className="hostel-compare-head"><div><h2>Compare hostels</h2><p>Live approved listings for this academic year. Prices are starting totals per year.</p></div><button type="button" onClick={() => setShowCompare(false)} aria-label="Close comparison">Close</button></div>
      {loading ? <p role="status">Refreshing prices and availability…</p> : compareError ? <p role="alert">{compareError}</p> : <div className="hostel-compare-scroll"><table><tbody>
        <tr><th scope="row">Hostel</th>{state.selected.map(item => <th scope="col" key={item.id}><Link href={`/hostel/${encodeURIComponent(item.id)}?periodId=${encodeURIComponent(state.periodId)}`}>{item.name}</Link><button type="button" onClick={() => state.toggleCompare(item)} aria-label={`Remove ${item.name} from comparison`}>×</button></th>)}</tr>
        <tr><th scope="row">From / year</th>{ordered.map((item, index) => <td key={state.selected[index].id}>{item ? item.availableSpaces ? cedis(item.minTotal) : "Beds being prepared" : "Unavailable"}</td>)}</tr>
        <tr><th scope="row">Available beds</th>{ordered.map((item, index) => <td key={state.selected[index].id}>{item ? bedsLabel(item.availableSpaces) : "—"}</td>)}</tr>
        <tr><th scope="row">Distance</th>{ordered.map((item, index) => <td key={state.selected[index].id}>{item ? distanceLabel(item.distanceM) : "—"}</td>)}</tr>
        <tr><th scope="row">Rooms</th>{ordered.map((item, index) => <td key={state.selected[index].id}>{item?.roomCount ?? "—"}</td>)}</tr>
        <tr><th scope="row">Utilities in total</th>{ordered.map((item, index) => <td key={state.selected[index].id}>{item ? item.utilitiesEnabled ? "Yes" : "No" : "—"}</td>)}</tr>
        <tr><th scope="row">Resident rating</th>{ordered.map((item, index) => <td key={state.selected[index].id}>{item?.ratingCount ? `${item.ratingAverage.toFixed(1)} / 5 (${item.ratingCount})` : "No reviews yet"}</td>)}</tr>
      </tbody></table></div>}
      <p className="hostel-detail-note">Prices and beds can change before booking. Open a hostel to see its current bed options.</p>
    </div>}
  </section>;
}
