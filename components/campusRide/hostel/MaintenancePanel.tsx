"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowClockwise, Plus, Wrench } from "@/components/ui/MaterialIcon";
import Link from "next/link";
import { ResidencyDialog } from "./ResidencyDialog";
import { MAINTENANCE_CATEGORIES, MAINTENANCE_LABELS as LABEL, MAINTENANCE_STATUSES, MAX_MAINTENANCE_PHOTO_BYTES, type MaintenanceAction, type MaintenanceConfig, type MaintenanceDetail, type MaintenanceDraft, type MaintenanceList, type MaintenancePerson } from "@/lib/hostel-engine/maintenance-types";
import "./maintenance.css";

type Props = { reference?: string; properties?: Array<{ id: string; name: string }> };
type Queue = MaintenanceList & { assignees?: MaintenancePerson[] };
type Detail = MaintenanceDetail & { assignees?: MaintenancePerson[] };
const when = (value: string) => value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const message = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed. Try again.";
const label = (value: string, staff = false) => value === "WAITING_FOR_STUDENT" && staff ? "Waiting for student" : LABEL[value] || value;
async function api<T>(url: string, method = "GET", data?: object, photos: File[] = []): Promise<T> {
  const form = new FormData();
  if (data) form.set("data", JSON.stringify(data));
  photos.forEach(file => form.append("photos", file));
  const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", ...(data ? { body: form } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request could not be completed. Try again.");
  return result as T;
}
function draftFor(reference: string): MaintenanceDraft {
  return { reference, clientRequestId: crypto.randomUUID(), category: "PLUMBING", urgency: "ROUTINE", locationType: "ROOM", locationDetail: "", title: "", description: "", entryPermission: "ARRANGE_FIRST", preferredAccess: "" };
}

export function MaintenancePanel({ reference, properties = [] }: Props) {
  const staff = reference === undefined;
  const endpoint = staff ? "/api/console/hostel/maintenance" : "/api/hostel/maintenance";
  const [queue, setQueue] = useState<Queue | null>(null);
  const [filters, setFilters] = useState({ propertyId: "", status: "OPEN", category: "", urgency: "", assignee: "", q: "", overdue: "", escalated: "" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MaintenanceDraft | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [settings, setSettings] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const id = ++sequence.current;
    setLoading(true);
    try {
      const query = new URLSearchParams({ ...filters, page: String(page), ...(reference ? { reference } : {}) });
      const result = await api<Queue>(`${endpoint}?${query}`);
      if (id === sequence.current) { setQueue(result); setError(""); }
    } catch (cause) { if (id === sequence.current) setError(message(cause)); }
    finally { if (id === sequence.current) setLoading(false); }
  }, [endpoint, filters, page, reference]);
  useEffect(() => { const seq = sequence; queueMicrotask(() => void load()); return () => { seq.current++; }; }, [load]);
  useEffect(() => { const timer = setTimeout(() => { setFilters(value => value.q === search ? value : { ...value, q: search }); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  const filter = (key: keyof typeof filters, value: string) => { setFilters(current => ({ ...current, [key]: value })); setPage(1); };
  const config = queue?.config;
  return <section className="maintenance-panel" aria-label="Maintenance requests">
    <header className="maintenance-heading"><div><span className="maintenance-eyebrow"><Wrench size={16} aria-hidden /> RESIDENT CARE</span><h3>{staff ? "Maintenance desk" : "Report it. Follow it. Resolve it."}</h3><p>{staff ? "A shared queue for repairs, updates and resident follow-up." : "Keep room and shared-area problems in one place."}</p></div>
      <div className="maintenance-actions"><button type="button" disabled={loading} onClick={() => void load()} aria-label="Refresh maintenance requests"><ArrowClockwise size={18} aria-hidden /> Refresh</button>{staff && queue?.isOwner && <button type="button" onClick={() => setSettings(true)}>Property settings</button>}{!staff && <button className="maintenance-primary" type="button" disabled={!config?.canCreate} onClick={() => { setDraft(value => value || draftFor(reference!)); setCreating(true); }}><Plus size={18} aria-hidden />{draft ? "Continue draft" : "Report a problem"}</button>}</div>
    </header>
    {config && <div className="maintenance-service-note"><p>{config.canCreate ? <><strong>Service hours:</strong> {config.serviceHours}. First response target: {config.acknowledgementHours} elapsed hours.</> : "New reports are available for current paid stays when maintenance is enabled by the platform and your hostel. Existing reports remain available."}</p><p>For immediate danger, contact local emergency services. Urgent reports do not guarantee an immediate response.{config.urgentContact && <> Hostel contact: <a href={`tel:${config.urgentContact}`}>{config.urgentContact}</a>.</>}</p></div>}
    {queue && staff && <div className="maintenance-metrics" aria-label="Queue summary"><div><strong>{queue.summary.open}</strong><span>Open reports</span></div><div><strong>{queue.summary.overdue}</strong><span>First response overdue</span></div><div><strong>{queue.summary.escalated}</strong><span>Escalated</span></div><div><strong>{queue.summary.resolved}</strong><span>Awaiting confirmation</span></div></div>}
    <div className="maintenance-filters">
      <label className="maintenance-search">Search reports<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Reference, room or issue" maxLength={100} /></label>
      <label>Status<select value={filters.status} onChange={event => filter("status", event.target.value)}><option value="OPEN">Open reports</option><option value="">All reports</option>{MAINTENANCE_STATUSES.map(value => <option key={value} value={value}>{label(value, staff)}</option>)}</select></label>
      {staff && <label>Property<select value={filters.propertyId} onChange={event => filter("propertyId", event.target.value)}><option value="">All properties</option>{properties.map(property => <option value={property.id} key={property.id}>{property.name}</option>)}</select></label>}
      <details className="maintenance-extra-filters"><summary>More filters</summary><div>
        <label>Category<select value={filters.category} onChange={event => filter("category", event.target.value)}><option value="">All categories</option>{MAINTENANCE_CATEGORIES.map(value => <option key={value} value={value}>{LABEL[value]}</option>)}</select></label>
        <label>Urgency<select value={filters.urgency} onChange={event => filter("urgency", event.target.value)}><option value="">Any urgency</option><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option></select></label>
        {staff && <label>Assigned to<select value={filters.assignee} onChange={event => filter("assignee", event.target.value)}><option value="">Anyone</option><option value="UNASSIGNED">Unassigned</option>{queue?.assignees?.map(person => <option value={person.email} key={person.email}>{person.name}</option>)}</select></label>}
        <label className="maintenance-check"><input type="checkbox" checked={filters.overdue === "1"} onChange={event => filter("overdue", event.target.checked ? "1" : "")} />First response overdue</label>
        <label className="maintenance-check"><input type="checkbox" checked={filters.escalated === "1"} onChange={event => filter("escalated", event.target.checked ? "1" : "")} />Escalated to owner</label>
      </div></details>
    </div>
    {error && <p className="residency-alert" role="alert">{error} <button type="button" onClick={() => void load()}>Try again</button></p>}
    {notice && <p className="residency-success" role="status">{notice}</p>}
    {loading && <p role="status">Updating maintenance requests…</p>}
    {queue && <div className="maintenance-list" aria-busy={loading}>{queue.tickets.map(ticket => <button type="button" className="maintenance-ticket" key={ticket.id} onClick={() => setSelected(ticket.id)}>
      <div><span className="maintenance-reference">{ticket.reference} · {LABEL[ticket.category]}</span><strong>{ticket.title}</strong><span>{staff ? `${ticket.propertyName} · ${ticket.studentName} · ` : ""}{ticket.locationType === "SHARED" ? "Shared area" : `${ticket.roomLabel} · ${ticket.spaceLabel}`} · {ticket.locationDetail}</span><small>{ticket.assigneeName ? `Assigned to ${ticket.assigneeName}` : "Awaiting staff assignment"} · {when(ticket.updatedAt)}</small></div>
      <div className="maintenance-badges"><span className={`maintenance-badge is-${ticket.status.toLowerCase()}`}>{label(ticket.status, staff)}</span>{ticket.urgency === "URGENT" && <span className="maintenance-badge is-urgent">Urgent</span>}{ticket.overdue && <span className="maintenance-badge is-urgent">Response overdue</span>}{ticket.escalatedAt && <span className="maintenance-badge">Escalated</span>}<span className="maintenance-open">View report →</span></div>
    </button>)}</div>}
    {queue && !loading && !error && !queue.tickets.length && <div className="maintenance-empty"><Wrench size={28} aria-hidden /><h4>No reports in this view</h4><p>{filters.status === "OPEN" ? "Closed and cancelled requests are available under All reports." : "Try another filter or search."}</p></div>}
    {queue && queue.pagination.total > 0 && <nav className="residency-pagination" aria-label="Maintenance pages"><span>{queue.pagination.total} reports · Page {queue.pagination.page} of {queue.pagination.pages}</span><div><button type="button" disabled={loading || queue.pagination.page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button type="button" disabled={loading || queue.pagination.page >= queue.pagination.pages} onClick={() => setPage(page + 1)}>Next</button></div></nav>}
    <p className="maintenance-help"><Link href={staff ? "/console/hostels/guide#maintenance" : "/hostel/help#maintenance"}>Maintenance guide &amp; AI help</Link></p>
    {draft && <NewReport open={creating} endpoint={endpoint} config={config} draft={draft} setDraft={setDraft} photos={photos} setPhotos={setPhotos} onClose={() => setCreating(false)} onSaved={detail => { setCreating(false); setDraft(null); setPhotos([]); setSelected(detail.ticket.id); setNotice("Your report was submitted. Follow staff updates here."); void load(); }} />}
    {selected && <ReportDetail key={selected} id={selected} endpoint={endpoint} staff={staff} onClose={() => setSelected("")} onChanged={() => void load()} />}
    {settings && <MaintenanceSettings endpoint={endpoint} properties={properties} initialProperty={filters.propertyId} onClose={() => setSettings(false)} onSaved={() => { setNotice("Maintenance settings saved."); void load(); }} />}
  </section>;
}

export function PhotoPicker({ photos, onChange, disabled = false, maxTotal = 10 }: { photos: File[]; onChange: (files: File[]) => void; disabled?: boolean; maxTotal?: number }) {
  const [error, setError] = useState("");
  return <div className="maintenance-photo-picker"><label>Photos (optional)<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled} onChange={event => {
    const selected = [...photos, ...Array.from(event.target.files || [])]; event.target.value = "";
    if (selected.length > 3 || selected.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > MAX_MAINTENANCE_PHOTO_BYTES || !file.size)) { setError("Choose up to 3 JPEG, PNG or WebP photos, up to 6 MB each. Export HEIC photos as JPEG first."); return; }
    setError(""); onChange(selected);
  }} /></label><small>Private to you and authorized hostel staff. Up to 3 photos per update, {maxTotal} per record. Avoid personal documents and other people.</small>{photos.length > 0 && <ul>{photos.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span><button type="button" disabled={disabled} aria-label={`Remove ${file.name}`} onClick={() => onChange(photos.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>}{error && <p className="residency-alert" role="alert">{error}</p>}</div>;
}

function NewReport({ open, endpoint, config, draft, setDraft, photos, setPhotos, onClose, onSaved }: {
  open: boolean; endpoint: string; config?: MaintenanceConfig; draft: MaintenanceDraft; setDraft: (value: MaintenanceDraft) => void; photos: File[]; setPhotos: (value: File[]) => void; onClose: () => void; onSaved: (detail: Detail) => void;
}) {
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = (key: keyof MaintenanceDraft, value: string) => setDraft({ ...draft, [key]: value });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!review) { setReview(true); return; }
    setBusy(true); setError("");
    try { onSaved(await api<Detail>(endpoint, "POST", draft, photos)); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <ResidencyDialog open={open} title={review ? "Review your report" : "Report a problem"} busy={busy} onClose={onClose}>
    <form className="residency-form maintenance-form" onSubmit={submit}>
      <ol className="maintenance-steps" aria-label="Report progress"><li aria-current={!review ? "step" : undefined}>1 · Problem details</li><li aria-current={review ? "step" : undefined}>2 · Review &amp; send</li></ol>
      {review ? <><h3>{draft.title}</h3><dl className="residency-details"><div><dt>Property</dt><dd>{config?.propertyName}</dd></div><div><dt>Category &amp; urgency</dt><dd>{LABEL[draft.category]} · {LABEL[draft.urgency]}</dd></div><div><dt>Location</dt><dd>{LABEL[draft.locationType]} · {draft.locationDetail}</dd></div><div><dt>Entry preference</dt><dd>{LABEL[draft.entryPermission]}</dd></div>{draft.preferredAccess && <div><dt>Preferred access</dt><dd>{draft.preferredAccess}</dd></div>}<div><dt>Photos</dt><dd>{photos.length} private attachments</dd></div></dl><p className="maintenance-prose">{draft.description}</p><p>Staff will review your report. Target for the first response: {config?.acknowledgementHours || 24} elapsed hours. Urgent reports are not an emergency service.</p></> : <fieldset disabled={busy}>
        <label>Short description<input required minLength={5} maxLength={120} value={draft.title} onChange={event => change("title", event.target.value)} placeholder="e.g. Bathroom tap keeps leaking" /></label>
        <div className="maintenance-two-fields"><label>Category<select value={draft.category} onChange={event => change("category", event.target.value)}>{MAINTENANCE_CATEGORIES.map(value => <option key={value} value={value}>{LABEL[value]}</option>)}</select></label><label>Urgency<select value={draft.urgency} onChange={event => change("urgency", event.target.value)}><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option></select></label></div>
        <div className="maintenance-two-fields"><label>Location<select value={draft.locationType} onChange={event => change("locationType", event.target.value)}><option value="ROOM">My room / bed</option><option value="SHARED">Shared area</option></select></label><label>Exact location<input required minLength={2} maxLength={160} value={draft.locationDetail} onChange={event => change("locationDetail", event.target.value)} placeholder="e.g. Bathroom, next to the shower" /></label></div>
        <label>What happened?<textarea required minLength={10} maxLength={2000} rows={4} value={draft.description} onChange={event => change("description", event.target.value)} placeholder="Describe what is wrong, when it started and how it affects you." /></label>
        <label>Access preference<select value={draft.entryPermission} onChange={event => change("entryPermission", event.target.value)}>{["ARRANGE_FIRST", "PRESENT_ONLY", "PERMITTED"].map(value => <option key={value} value={value}>{LABEL[value]}</option>)}</select></label>
        <label>Preferred access time (optional)<input maxLength={160} value={draft.preferredAccess} onChange={event => change("preferredAccess", event.target.value)} placeholder="e.g. Weekdays after 4 pm" /></label>
        <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />
        <p className="maintenance-muted">Only include facts you know. You can pause this form and return while this request list remains open.</p>
      </fieldset>}
      {error && <p className="residency-alert" role="alert">{error} Your draft and selected photos are still here.</p>}
      <footer><button type="button" disabled={busy} onClick={review ? () => setReview(false) : onClose}>{review ? "Edit details" : "Continue later"}</button><button className="maintenance-primary" type="submit" disabled={busy}>{busy ? "Sending…" : review ? "Submit report" : "Review report"}</button></footer>
    </form>
  </ResidencyDialog>;
}

function ReportDetail({ id, endpoint, staff, onClose, onChanged }: { id: string; endpoint: string; staff: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<MaintenanceAction | "">("");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [notice, setNotice] = useState("");
  const mutation = useRef({ fingerprint: "", key: "" });
  const load = useCallback(async () => { setBusy(true); try { setDetail(await api<Detail>(`${endpoint}?id=${encodeURIComponent(id)}`)); setError(""); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }, [id, endpoint]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!detail || !action) return;
    const input = { id, version: detail.ticket.version, action, note, assigneeEmail: action === "ASSIGN" ? assignee : "" };
    const fingerprint = JSON.stringify([input, photos.map(file => [file.name, file.size, file.lastModified])]);
    if (mutation.current.fingerprint !== fingerprint) mutation.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try { const updated = await api<Detail>(endpoint, "PATCH", { ...input, mutationId: mutation.current.key }, photos); setDetail({ ...updated, assignees: detail.assignees }); setAction(""); setNote(""); setPhotos([]); setNotice("Update saved."); onChanged(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const ticket = detail?.ticket;
  return <ResidencyDialog open title={ticket?.reference || "Maintenance report"} drawer busy={busy} onClose={onClose}>
    <div className="maintenance-detail">
      {error && <p className="residency-alert" role="alert">{error} <button type="button" disabled={busy} onClick={() => void load()}>Refresh details</button></p>}{notice && <p className="residency-success" role="status">{notice}</p>}
      {!detail && !error && <p role="status">Loading report…</p>}
      {detail && ticket && <><div className="maintenance-heading"><div><span className="maintenance-badge">{label(ticket.status, staff)}</span><h3>{ticket.title}</h3><p>{ticket.propertyName} · {ticket.roomLabel} · {ticket.spaceLabel}</p></div><button type="button" disabled={busy} onClick={() => void load()}>Refresh</button></div>
        <dl className="residency-details"><div><dt>Location</dt><dd>{LABEL[ticket.locationType]} · {ticket.locationDetail}</dd></div><div><dt>Category &amp; urgency</dt><dd>{LABEL[ticket.category]} · {LABEL[ticket.urgency]}</dd></div><div><dt>Assigned staff</dt><dd>{ticket.assigneeName || "Unassigned"}</dd></div><div><dt>Entry preference</dt><dd>{LABEL[ticket.entryPermission]}{ticket.preferredAccess && ` · ${ticket.preferredAccess}`}</dd></div>{staff && <div><dt>Reported by</dt><dd>{ticket.studentName} · {ticket.studentEmail}</dd></div>}<div><dt>First response target</dt><dd>{when(ticket.acknowledgementDueAt)}{ticket.overdue ? " · Overdue" : ticket.acknowledgedAt ? " · Acknowledged" : ""}</dd></div></dl>
        <p className="maintenance-prose">{ticket.description}</p>
        {detail.actions.length > 0 && <form className="residency-form maintenance-form maintenance-update" onSubmit={submit}><fieldset disabled={busy}><label>Next action<select value={action} onChange={event => { setAction(event.target.value as MaintenanceAction); setPhotos([]); setAssignee(ticket.assigneeEmail); setNotice(""); }}><option value="">Choose an action</option>{detail.actions.map(value => <option key={value} value={value}>{LABEL[value]}</option>)}</select></label>
          {action && <>{action === "ASSIGN" && <label>Staff member<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">Unassigned</option>{detail.assignees?.map(person => <option key={person.email} value={person.email}>{person.name}</option>)}</select></label>}
            <label>{["WAIT", "RESOLVE", "REOPEN", "CANCEL", "ESCALATE"].includes(action) ? "Explanation (required)" : "Message (optional)"}<textarea rows={3} maxLength={2000} required={["WAIT", "RESOLVE", "REOPEN", "CANCEL", "ESCALATE"].includes(action)} minLength={["WAIT", "RESOLVE", "REOPEN", "CANCEL", "ESCALATE"].includes(action) ? 5 : undefined} value={note} onChange={event => setNote(event.target.value)} placeholder={action === "RESOLVE" ? "Explain the repair and what the resident should check." : "Add details visible to the resident and hostel staff."} /></label>
            {["COMMENT", "RESOLVE", "REOPEN"].includes(action) && detail.files.length < 10 && <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />}
            {action === "CANCEL" && <p>Cancellation ends this report. Include the reason so staff know why.</p>}{action === "CLOSE" && <p>Confirm that the reported problem has been resolved. You can reopen the report if it returns.</p>}
            <button type="submit" className="maintenance-primary">{busy ? "Saving…" : LABEL[action]}</button></>}
        </fieldset></form>}
        <section className="maintenance-history"><h4>Activity &amp; photos</h4><p className="maintenance-muted">Most recent updates first. Up to 100 updates shown. Photos are private; refresh the report if a link expires.</p><ol>{detail.events.map(event => <li key={event.id}><div><strong>{LABEL[event.action] || event.action}</strong><time dateTime={event.createdAt}>{when(event.createdAt)}</time></div><small>{event.actorName} · {event.actorType === "STAFF" ? "Hostel staff" : "Resident"}{event.details.assigneeName ? ` · Assigned to ${event.details.assigneeName}` : ""}</small>{event.note && <p className="maintenance-prose">{event.note}</p>}{detail.files.some(file => file.eventId === event.id) && <div className="maintenance-photos">{detail.files.filter(file => file.eventId === event.id).map(file => <a key={file.id} href={file.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{file.name} ↗</a>)}</div>}</li>)}</ol></section>
      </>}
    </div>
  </ResidencyDialog>;
}

function MaintenanceSettings({ endpoint, properties, initialProperty, onClose, onSaved }: { endpoint: string; properties: Props["properties"]; initialProperty: string; onClose: () => void; onSaved: () => void }) {
  const [propertyId, setPropertyId] = useState(initialProperty || properties?.[0]?.id || "");
  const [config, setConfig] = useState<MaintenanceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => { if (!propertyId) return; setBusy(true); setConfig(null); setError(""); try { setConfig((await api<{ config: MaintenanceConfig }>(`${endpoint}/settings?propertyId=${encodeURIComponent(propertyId)}`)).config); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }, [endpoint, propertyId]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  async function submit(event: FormEvent) { event.preventDefault(); if (!config) return; setBusy(true); setError(""); setNotice(""); try { setConfig((await api<{ config: MaintenanceConfig }>(`${endpoint}/settings`, "PATCH", config)).config); setNotice("Property settings saved."); onSaved(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  return <ResidencyDialog open title="Property maintenance settings" busy={busy} onClose={onClose}><form className="residency-form maintenance-form" onSubmit={submit}>
    <label>Property<select disabled={busy} value={propertyId} onChange={event => { setPropertyId(event.target.value); setNotice(""); }}>{properties?.map(property => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
    {!propertyId && <p>Add a property before configuring maintenance.</p>}{busy && !config && <p role="status">Loading settings…</p>}
    {config && <fieldset disabled={busy}>{!config.platformEnabled && <p className="maintenance-service-note">The platform administrator has not enabled maintenance. You can prepare this property now; students can submit once both switches are on.</p>}<label className="maintenance-check"><input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />Accept new maintenance reports</label><label>Service hours<input maxLength={240} required={config.enabled} value={config.serviceHours} placeholder="Monday–Friday, 8 am–5 pm" onChange={event => setConfig({ ...config, serviceHours: event.target.value })} /></label><label>First response target (elapsed hours)<input type="number" min={1} max={168} required value={config.acknowledgementHours} onChange={event => setConfig({ ...config, acknowledgementHours: Number(event.target.value) })} /></label><p>The target runs continuously, including outside service hours. Turning off new reports preserves existing reports and follow-up. Only the owner can change these settings.</p><button type="submit" className="maintenance-primary">{busy ? "Saving…" : "Save settings"}</button></fieldset>}
    {error && <p className="residency-alert" role="alert">{error} <button type="button" disabled={busy} onClick={() => void load()}>Reload settings</button></p>}{notice && <p role="status" className="residency-success">{notice}</p>}
  </form></ResidencyDialog>;
}
