"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle, Plus, ShieldCheck, Warning } from "@/components/ui/MaterialIcon";
import { CurbsideChatModal } from "@/components/campusRide/shared/CurbsideChatModal";
import type { PrintCopyProviderRecord } from "@/lib/print-copy/directory";
import { PRINT_COPY_VERIFICATION_DAYS } from "@/lib/print-copy/constants";
import "./print-copy-console.css";

type Quote = { id: string; reference: string; provider_name: string; student_name: string; student_email: string; requirements: string; status: string; staff_note: string; created_at: string };
type Report = { id: string; provider_name: string; category: string; message: string; status: string; created_at: string };
const blank = { id: "", name: "", description: "", location: "", contactLabel: "Contact shop", contactHref: "tel:", hours: "", servicesText: "", indicativePricing: "", turnaround: "" };
function needsReverification(provider: PrintCopyProviderRecord) { return provider.status === "PUBLISHED" && (!Number.isFinite(Date.parse(provider.verifiedAt)) || Date.now() - Date.parse(provider.verifiedAt) > PRINT_COPY_VERIFICATION_DAYS * 24 * 60 * 60_000); }

export function PrintCopyManager() {
  const [providers, setProviders] = useState<PrintCopyProviderRecord[]>([]); const [quotes, setQuotes] = useState<Quote[]>([]); const [reports, setReports] = useState<Report[]>([]);
  const [settings, setSettings] = useState({ enabled: false, supportOwner: "" });
  const [activeQuoteChat, setActiveQuoteChat] = useState<string | null>(null);
  const [draft, setDraft] = useState(blank); const [notes, setNotes] = useState<Record<string,string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const responses = await Promise.all([fetch("/api/console/print-copy/providers", { cache: "no-store" }), fetch("/api/console/print-copy/quotes", { cache: "no-store" }), fetch("/api/console/print-copy/reports", { cache: "no-store" }), fetch("/api/console/print-copy/settings", { cache: "no-store" })]);
    const [providerData, quoteData, reportData, settingsData] = await Promise.all(responses.map((response) => response.json()));
    if (responses.some((response) => !response.ok)) throw new Error(providerData.error || quoteData.error || reportData.error || settingsData.error || "Print & Copy workspace could not be loaded.");
    setProviders(providerData.providers || []); setQuotes(quoteData.quotes || []); setReports(reportData.reports || []); setSettings(settingsData.settings || { enabled: false, supportOwner: "" });
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load().catch((problem) => setError(problem instanceof Error ? problem.message : "Workspace could not be loaded.")), 0); return () => clearTimeout(timer); }, [load]);
  function edit(provider?: PrintCopyProviderRecord) {
    setError("");
    setDraft(provider ? { id: provider.id, name: provider.name, description: provider.description, location: provider.location, contactLabel: provider.contactLabel, contactHref: provider.contactHref, hours: provider.hours, servicesText: provider.services.join(", "), indicativePricing: provider.indicativePricing, turnaround: provider.turnaround } : { ...blank });
    const field = document.getElementById("print-copy-provider-name");
    field?.focus();
    field?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy("save"); setError("");
    try {
      const response = await fetch("/api/console/print-copy/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, services: draft.servicesText.split(",").map((item) => item.trim()).filter(Boolean) }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Shop details could not be saved.");
      setDraft({ ...blank }); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Shop details could not be saved."); }
    finally { setBusy(""); }
  }
  async function decideProvider(provider: PrintCopyProviderRecord, action: "PUBLISH" | "SUSPEND") {
    const note = notes[provider.id] || ""; if (note.trim().length < 10) return;
    setBusy(provider.id); setError("");
    try {
      const response = await fetch("/api/console/print-copy/providers", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: provider.id, action, note }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Shop review could not be saved."); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Shop review could not be saved."); }
    finally { setBusy(""); }
  }
  async function updateQuote(quote: Quote, status: string) {
    setBusy(quote.id); setError("");
    try {
      const response = await fetch("/api/console/print-copy/quotes", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: quote.id, status, staffNote: notes[quote.id] ?? quote.staff_note }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Quote status could not be saved."); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Quote status could not be saved."); }
    finally { setBusy(""); }
  }
  async function resolveReport(report: Report, action: "RESOLVE" | "DISMISS") {
    setBusy(report.id); setError("");
    try {
      const response = await fetch("/api/console/print-copy/reports", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: report.id, action, note: notes[report.id] || "" }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Correction report could not be closed."); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Correction report could not be closed."); }
    finally { setBusy(""); }
  }
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault(); setBusy("settings"); setError("");
    try {
      const response = await fetch("/api/console/print-copy/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Quote controls could not be saved.");
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Quote controls could not be saved."); }
    finally { setBusy(""); }
  }
  return <div className="print-copy-console">
    <section className="print-copy-console-stats" aria-label="Print and Copy directory summary"><article><span>Shops</span><strong>{providers.length}</strong></article><article><span>Visible listings</span><strong>{providers.filter((row) => row.status === "PUBLISHED" && !needsReverification(row)).length}</strong></article><article><span>New quote requests</span><strong>{quotes.filter((row) => row.status === "NEW").length}</strong></article><article><span>Open corrections</span><strong>{reports.filter((row) => row.status === "OPEN").length}</strong></article></section>
    <section className="console-card print-copy-launch-note"><ShieldCheck size={22} aria-hidden /><div><h2>Provider review before publication</h2><p>Confirm shop identity, service list, location, hours, indicative pricing, turnaround and contact with a named provider. Quote requests do not accept document uploads. Students and staff should arrange file sharing directly with the shop using an agreed safe method.</p></div></section>
    {error && <p className="console-alert" role="alert">{error}</p>}
    <form className="console-card print-copy-quote-settings" onSubmit={saveSettings}><div><h2>Quote request controls</h2><p>Requests start off. Name the staff member responsible for follow-up before opening them. Closing requests leaves existing ones in the staff queue.</p></div><label className="print-copy-switch"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /> Accept new quote requests</label><label>Support owner<input value={settings.supportOwner} maxLength={120} onChange={(event) => setSettings({ ...settings, supportOwner: event.target.value })} placeholder="Staff name and team" /></label><button disabled={busy === "settings"}>{busy === "settings" ? "Saving…" : "Save quote controls"}</button></form>
    <section className="console-card"><header className="print-copy-section-head"><div><h2>Shop listings</h2><p>Saving edits returns a listing to draft. Published details disappear from the student directory after 30 days until staff reconfirm and publish them again.</p></div><button type="button" onClick={() => edit()}><Plus size={17} aria-hidden /> Add shop</button></header>
      {providers.length ? <div className="print-copy-provider-grid">{providers.map((provider) => <article key={provider.id} className="print-copy-provider-card"><header><div><span className={`print-copy-status is-${provider.status.toLowerCase()}`}>{needsReverification(provider) ? "REVERIFY" : provider.status}</span><h3>{provider.name}</h3><p>{provider.location}</p></div><button type="button" onClick={() => edit(provider)}>Edit</button></header><dl><div><dt>Services</dt><dd>{provider.services.join(", ")}</dd></div><div><dt>Hours</dt><dd>{provider.hours}</dd></div><div><dt>Pricing</dt><dd>{provider.indicativePricing || "Not listed"}</dd></div><div><dt>Turnaround</dt><dd>{provider.turnaround || "Not listed"}</dd></div><div><dt>Verified</dt><dd>{provider.verifiedAt ? new Date(provider.verifiedAt).toLocaleDateString("en-GH", { dateStyle: "medium" }) : "Not yet"}</dd></div></dl><label>Verification source or suspension reason<textarea rows={2} maxLength={500} value={notes[provider.id] || ""} onChange={(event) => setNotes({ ...notes, [provider.id]: event.target.value })} placeholder="Name who confirmed these details" /></label><div className="print-copy-staff-actions"><button disabled={busy === provider.id || (notes[provider.id] || "").trim().length < 10} onClick={() => void decideProvider(provider, "PUBLISH")}><CheckCircle size={15} aria-hidden /> Publish</button><button disabled={busy === provider.id || (notes[provider.id] || "").trim().length < 10} onClick={() => void decideProvider(provider, "SUSPEND")}>Suspend</button></div></article>)}</div> : <p className="print-copy-console-empty"><Warning size={19} aria-hidden /> No shops are entered yet. Add a provider only after confirming a named contact.</p>}
      <form className="print-copy-editor" onSubmit={save}><h3>{draft.id ? "Edit shop draft" : "Add a shop"}</h3><p>Do not enter unconfirmed claims. Use plain text for services, pricing and turnaround.</p><div className="print-copy-editor-grid"><label>Shop name<input id="print-copy-provider-name" required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Location<input required maxLength={240} value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label><label className="wide">Description<textarea rows={2} maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label>Services, comma separated<input required maxLength={500} value={draft.servicesText} onChange={(event) => setDraft({ ...draft, servicesText: event.target.value })} placeholder="Photocopying, binding, colour printing" /></label><label>Opening hours<input required maxLength={180} value={draft.hours} onChange={(event) => setDraft({ ...draft, hours: event.target.value })} /></label><label>Indicative pricing<input maxLength={500} value={draft.indicativePricing} onChange={(event) => setDraft({ ...draft, indicativePricing: event.target.value })} placeholder="e.g. Black and white copies from GH₵…" /></label><label>Typical turnaround<input maxLength={180} value={draft.turnaround} onChange={(event) => setDraft({ ...draft, turnaround: event.target.value })} /></label><label>Contact button label<input required maxLength={80} value={draft.contactLabel} onChange={(event) => setDraft({ ...draft, contactLabel: event.target.value })} /></label><label>Contact link<input required maxLength={300} value={draft.contactHref} onChange={(event) => setDraft({ ...draft, contactHref: event.target.value })} placeholder="tel:+233… or https://…" /></label></div><div className="print-copy-staff-actions"><button disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save draft"}</button>{draft.id && <button type="button" onClick={() => setDraft({ ...blank })}>Clear form</button>}</div></form>
    </section>
    <section className="console-card"><header className="print-copy-section-head"><div><h2>Quote requests</h2><p>Student contact details are visible only to authorized Print & Copy staff. Read access is audit logged.</p></div></header>{quotes.length ? <div className="print-copy-request-list">{quotes.map((quote) => <article key={quote.id}><div><span className={`print-copy-status is-${quote.status.toLowerCase()}`}>{quote.status}</span><h3>{quote.reference} · {quote.provider_name}</h3><p>{quote.student_name} · <a href={`mailto:${encodeURIComponent(quote.student_email)}`}>{quote.student_email}</a></p><p className="print-copy-request-body">{quote.requirements}</p><small>{new Date(quote.created_at).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}</small></div><div className="print-copy-quote-actions"><label>Staff follow-up note<textarea rows={2} maxLength={500} value={notes[quote.id] ?? quote.staff_note} onChange={(event) => setNotes({ ...notes, [quote.id]: event.target.value })} /></label><div><button type="button" onClick={() => setActiveQuoteChat(quote.reference)}>💬 Chat</button><button disabled={busy === quote.id} onClick={() => void updateQuote(quote, "IN_PROGRESS")}>In progress</button><button disabled={busy === quote.id} onClick={() => void updateQuote(quote, "CLOSED")}>Close</button></div></div></article>)}</div> : <p>No quote requests yet.</p>}</section>
    <section className="console-card"><header className="print-copy-section-head"><div><h2>Listing corrections</h2><p>Check reported details with the shop before changing a public claim.</p></div></header>{reports.filter((row) => row.status === "OPEN").length ? <div className="print-copy-request-list">{reports.filter((row) => row.status === "OPEN").map((report) => <article key={report.id}><div><span className="print-copy-status is-open">{report.category}</span><h3>{report.provider_name}</h3><p>{report.message}</p></div><div className="print-copy-quote-actions"><label>Outcome note<textarea rows={2} maxLength={500} value={notes[report.id] || ""} onChange={(event) => setNotes({ ...notes, [report.id]: event.target.value })} /></label><div><button disabled={busy === report.id || (notes[report.id] || "").trim().length < 5} onClick={() => void resolveReport(report, "RESOLVE")}>Resolve</button><button disabled={busy === report.id || (notes[report.id] || "").trim().length < 5} onClick={() => void resolveReport(report, "DISMISS")}>Dismiss</button></div></div></article>)}</div> : <p>No corrections are waiting.</p>}</section>
    {activeQuoteChat && (
      <CurbsideChatModal
        open={Boolean(activeQuoteChat)}
        onClose={() => setActiveQuoteChat(null)}
        service="print-copy"
        reference={activeQuoteChat}
        title={`Quote ${activeQuoteChat}`}
      />
    )}
  </div>;
}
