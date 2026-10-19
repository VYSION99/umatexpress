"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, Flag, Plus, ShieldCheck, Warning } from "@/components/ui/MaterialIcon";
import type { FoodProviderRecord } from "@/lib/food/listings";
import "./food-console.css";

type Report = { id: string; provider_name: string; category: string; message: string; status: string; created_at: string };
type MenuDraft = { id?: string; name: string; description: string; priceGhs: string; dietaryNote: string };
const blank = { id: "", name: "", description: "", location: "", contactLabel: "Call provider", contactHref: "tel:", hours: "", pickupDetails: "", menuItems: [{ name: "", description: "", priceGhs: "", dietaryNote: "" }] as MenuDraft[] };

export function FoodDirectoryManager() {
  const editor = useRef<HTMLDialogElement>(null);
  const [providers, setProviders] = useState<FoodProviderRecord[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [draft, setDraft] = useState(blank);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const [providerResponse, reportResponse] = await Promise.all([fetch("/api/console/food/providers", { cache: "no-store" }), fetch("/api/console/food/reports", { cache: "no-store" })]);
    const providerData = await providerResponse.json() as { providers?: FoodProviderRecord[]; error?: string };
    const reportData = await reportResponse.json() as { reports?: Report[]; error?: string };
    if (!providerResponse.ok || !reportResponse.ok) throw new Error(providerData.error || reportData.error || "Food directory could not be loaded.");
    setProviders(providerData.providers || []); setReports(reportData.reports || []);
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load().catch((problem) => setError(problem instanceof Error ? problem.message : "Food directory could not be loaded.")), 0); return () => clearTimeout(timer); }, [load]);
  function open(provider?: FoodProviderRecord) {
    setError("");
    setDraft(provider ? { id: provider.id, name: provider.name, description: provider.description, location: provider.location, contactLabel: provider.contactLabel, contactHref: provider.contactHref, hours: provider.hours, pickupDetails: provider.pickupDetails, menuItems: provider.menuItems.map((item) => ({ id: item.id, name: item.name, description: item.description, priceGhs: String(item.priceGhs), dietaryNote: item.dietaryNote })) } : structuredClone(blank));
    editor.current?.showModal();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy("save"); setError("");
    try {
      const response = await fetch("/api/console/food/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, menuItems: draft.menuItems.map((item) => ({ ...item, priceGhs: Number(item.priceGhs) })) }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Provider could not be saved.");
      editor.current?.close(); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Provider could not be saved."); }
    finally { setBusy(""); }
  }
  async function decide(id: string, action: "PUBLISH" | "SUSPEND") {
    setBusy(id); setError("");
    try {
      const response = await fetch("/api/console/food/providers", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action, note: notes[id] || "" }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Decision could not be saved."); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Decision could not be saved."); } finally { setBusy(""); }
  }
  async function resolve(report: Report, action: "RESOLVE" | "DISMISS") {
    setBusy(report.id); setError("");
    try {
      const response = await fetch("/api/console/food/reports", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: report.id, action, note: notes[report.id] || "" }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Report could not be closed."); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Report could not be closed."); } finally { setBusy(""); }
  }
  const openReports = reports.filter((report) => report.status === "OPEN");
  return <div className="food-console">
    <section className="food-console-stats" aria-label="Food directory status"><article><span>Providers</span><strong>{providers.length}</strong></article><article><span>Published</span><strong>{providers.filter((item) => item.status === "PUBLISHED").length}</strong></article><article><span>Corrections</span><strong>{openReports.length}</strong></article><button onClick={() => open()}><Plus size={18} aria-hidden /> Add provider</button></section>
    <section className="console-card food-launch-gate"><ShieldCheck size={23} aria-hidden /><div><h2>Publication gate</h2><p>Editing a provider returns it to draft. Check the provider identity, location, contact, hours, menu and prices before publishing again. Food remains a directory; this screen cannot take orders or payments.</p></div></section>
    {error && <p className="console-alert" role="alert">{error}</p>}
    <section className="console-card"><div className="food-section-heading"><div><h2>Providers</h2><p>Each listing carries its own confirmation date and verification record.</p></div><button onClick={() => void load()}>Refresh</button></div>
      {providers.length === 0 ? <div className="food-console-empty"><Warning size={22} aria-hidden /><p>No providers yet. Add one only when a named provider contact can confirm the listing.</p></div> : <div className="food-provider-grid">{providers.map((provider) => <article className="food-provider-card" key={provider.id}>
        <div className="food-provider-top"><div><span className={`food-status is-${provider.status.toLowerCase()}`}>{provider.status}</span><h3>{provider.name}</h3><p>{provider.location}</p></div><button onClick={() => open(provider)}>Edit</button></div>
        <dl><div><dt>Hours</dt><dd>{provider.hours}</dd></div><div><dt>Menu</dt><dd>{provider.menuItems.length} item{provider.menuItems.length === 1 ? "" : "s"}</dd></div><div><dt>Last confirmed</dt><dd>{provider.lastConfirmedAt ? new Date(provider.lastConfirmedAt).toLocaleDateString("en-GH", { dateStyle: "medium" }) : "Not yet"}</dd></div></dl>
        <label>Verification source or suspension reason<textarea rows={2} maxLength={500} value={notes[provider.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder="Name the provider contact and what was checked" /></label>
        <div className="food-card-actions"><button disabled={busy === provider.id || (notes[provider.id] || "").trim().length < 10} onClick={() => void decide(provider.id, "PUBLISH")}><CheckCircle size={16} aria-hidden /> Publish</button><button disabled={busy === provider.id || (notes[provider.id] || "").trim().length < 10} onClick={() => void decide(provider.id, "SUSPEND")}>Suspend</button></div>
      </article>)}</div>}
    </section>
    <section className="console-card"><div className="food-section-heading"><div><h2>Student corrections</h2><p>Confirm the report with the provider before changing a published claim.</p></div><span className="food-report-count"><Flag size={15} aria-hidden /> {openReports.length} open</span></div>
      {openReports.length === 0 ? <p>No corrections are waiting.</p> : <div className="food-report-list">{openReports.map((report) => <article key={report.id}><div><span>{report.category}</span><h3>{report.provider_name}</h3><p>{report.message}</p></div><label>Outcome note<input value={notes[report.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [report.id]: event.target.value }))} placeholder="What staff checked" /></label><div><button disabled={busy === report.id || (notes[report.id] || "").trim().length < 5} onClick={() => void resolve(report, "RESOLVE")}>Resolve</button><button disabled={busy === report.id || (notes[report.id] || "").trim().length < 5} onClick={() => void resolve(report, "DISMISS")}>Dismiss</button></div></article>)}</div>}
    </section>
    <dialog ref={editor} className="food-editor"><form onSubmit={save}><header><div><span>PROVIDER RECORD</span><h2>{draft.id ? "Edit provider" : "Add provider"}</h2><p>Saving changes creates a draft for staff verification.</p></div><button type="button" aria-label="Close editor" onClick={() => editor.current?.close()}>×</button></header><div className="food-form-grid">
      <label>Provider name<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Location<input required maxLength={240} value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label><label className="wide">Short description<textarea rows={2} maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label>Opening hours<input required maxLength={180} value={draft.hours} onChange={(event) => setDraft({ ...draft, hours: event.target.value })} placeholder="Mon–Sat, 7:00 AM–8:00 PM" /></label><label>Pickup details<input maxLength={240} value={draft.pickupDetails} onChange={(event) => setDraft({ ...draft, pickupDetails: event.target.value })} /></label><label>Contact action<input required maxLength={80} value={draft.contactLabel} onChange={(event) => setDraft({ ...draft, contactLabel: event.target.value })} /></label><label>Contact link<input required maxLength={300} value={draft.contactHref} onChange={(event) => setDraft({ ...draft, contactHref: event.target.value })} placeholder="tel:+233… or https://…" /></label>
    </div><div className="food-menu-editor"><div><h3>Menu</h3><button type="button" onClick={() => setDraft({ ...draft, menuItems: [...draft.menuItems, { name: "", description: "", priceGhs: "", dietaryNote: "" }] })}><Plus size={16} aria-hidden /> Add item</button></div>{draft.menuItems.map((item, index) => <div className="food-menu-row" key={item.id || index}><label>Item<input required value={item.name} onChange={(event) => setDraft({ ...draft, menuItems: draft.menuItems.map((row, position) => position === index ? { ...row, name: event.target.value } : row) })} /></label><label>Price (GH₵)<input required inputMode="decimal" type="number" min="0" step="0.01" value={item.priceGhs} onChange={(event) => setDraft({ ...draft, menuItems: draft.menuItems.map((row, position) => position === index ? { ...row, priceGhs: event.target.value } : row) })} /></label><label>Description<input value={item.description} onChange={(event) => setDraft({ ...draft, menuItems: draft.menuItems.map((row, position) => position === index ? { ...row, description: event.target.value } : row) })} /></label><label>Dietary note<input value={item.dietaryNote} onChange={(event) => setDraft({ ...draft, menuItems: draft.menuItems.map((row, position) => position === index ? { ...row, dietaryNote: event.target.value } : row) })} /></label><button type="button" aria-label={`Remove ${item.name || `menu item ${index + 1}`}`} disabled={draft.menuItems.length === 1} onClick={() => setDraft({ ...draft, menuItems: draft.menuItems.filter((_, position) => position !== index) })}>×</button></div>)}</div><footer><button type="button" onClick={() => editor.current?.close()}>Cancel</button><button className="primary" disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save draft"}</button></footer></form></dialog>
  </div>;
}
