"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CalendarDots, FilmSlate, MagnifyingGlass, Plus, SealCheck, Star, Ticket, UsersThree } from "@/components/ui/MaterialIcon";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import { validStudentEmail } from "@/lib/student-email";
import type { CinemaEvent } from "@/lib/cinema-engine/events";
import { CinemaDialog } from "./CinemaDialog";
import "./cinema.css";

const SECTIONS = ["UPCOMING", "LIVE", "REPLAY"] as const;

export function CinemaEvents() {
  const { account } = useStudentAccount();
  const [events, setEvents] = useState<CinemaEvent[]>([]); const [section, setSection] = useState<(typeof SECTIONS)[number]>("UPCOMING");
  const [query, setQuery] = useState(""); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", organizerName: "", organizerType: "STUDENT_GROUP", format: "SCREENING", stageLimit: "6", video: "", startsAt: "", durationMinutes: "60", capacity: "100", recurrenceCount: "1", certificatesEnabled: false });
  const [poster, setPoster] = useState<File | null>(null);
  const [organizers, setOrganizers] = useState<Array<{ name: string; type: string; status: string }>>([]);
  const [affiliation, setAffiliation] = useState("");
  const loadOrganizers = useCallback(async () => {
    if (!account || !validStudentEmail(account.email)) return;
    const response = await fetch("/api/cinema/organizers", { credentials: "same-origin", cache: "no-store" });
    if (response.ok) { const data = await response.json() as { organizers?: Array<{ name: string; type: string; status: string }> }; setOrganizers(data.organizers || []); }
  }, [account]);
  useEffect(() => { void loadOrganizers(); }, [loadOrganizers]);
  const organization = organizers.find((item) => item.name.toLowerCase() === form.organizerName.trim().toLowerCase() && item.type === form.organizerType);
  const needsApproval = form.organizerType !== "STUDENT_GROUP" && organization?.status !== "ACTIVE";
  const requestApproval = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cinema/organizers", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.organizerName, type: form.organizerType, affiliation }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Approval request could not be sent.");
      await loadOrganizers(); setAffiliation("");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Approval request could not be sent."); }
    finally { setBusy(false); }
  };

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/cinema/events?section=${section}&q=${encodeURIComponent(query.trim())}`, { cache: "no-store", credentials: "same-origin" });
      const data = await response.json() as { events?: CinemaEvent[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The event catalogue could not be loaded.");
      setEvents(data.events || []);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The event catalogue could not be loaded."); }
    finally { setLoading(false); }
  }, [query, section]);
  useEffect(() => { const timer = setTimeout(() => void load(), 250); return () => clearTimeout(timer); }, [load]);

  const create = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cinema/events", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, capacity: Number(form.capacity), stageLimit: Number(form.stageLimit), durationMinutes: Number(form.durationMinutes), recurrenceCount: Number(form.recurrenceCount) }) });
      const data = await response.json() as { events?: CinemaEvent[]; error?: string };
      if (!response.ok || !data.events?.length) throw new Error(data.error || "The event could not be published.");
      // The event exists now. Close the form before optional media upload so
      // a poster failure cannot make a second publish look like a retry.
      setCreateOpen(false);
      setForm({ title: "", description: "", organizerName: "", organizerType: "STUDENT_GROUP", format: "SCREENING", stageLimit: "6", video: "", startsAt: "", durationMinutes: "60", capacity: "100", recurrenceCount: "1", certificatesEnabled: false });
      setPoster(null);
      if (poster) await Promise.all(data.events.map(async (event) => {
        const uploaded = await fetch(`/api/cinema/events/${event.id}/poster`, { method: "POST", credentials: "same-origin", headers: { "content-type": poster.type }, body: poster });
        if (!uploaded.ok) { const result = await uploaded.json().catch(() => ({})) as { error?: string }; throw new Error(result.error || "The event was published, but its poster could not be uploaded."); }
      }));
      setSection("UPCOMING"); await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The event could not be published."); }
    finally { setBusy(false); }
  };

  const visible = events;
  return <div className="cinema-events-page">
    <section className="cinema-events-hero">
      <div><span className="cinema-eyebrow">CINEMA LIVE</span><h2>Live video, real conversations.</h2><p>Watch campus streams, debates and panels. Join the audience, ask questions, vote and request the speaking stage.</p></div>
      <div className="cinema-controls">{account && validStudentEmail(account.email) ? <button className="cinema-cta" onClick={() => setCreateOpen(true)}><Plus size={18} /> Publish event</button> : !account ? <Link className="cinema-cta" href="/account?next=%2Fcinema">Sign in to participate</Link> : <span className="cinema-note">UMaT student organizers can publish events.</span>}{account && validStudentEmail(account.email) && <Link className="cinema-rooms-link" href="/cinema/rooms"><FilmSlate size={18} /> Open your rooms</Link>}</div>
    </section>
    <div className="cinema-event-tools">
      <nav className="cinema-filters" aria-label="Event sections">{SECTIONS.map((value) => <button key={value} aria-pressed={section === value} onClick={() => setSection(value)}>{value === "REPLAY" ? "Replays" : value === "LIVE" ? "Live now" : "Upcoming"}</button>)}</nav>
      <label className="cinema-search"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events or organizers" aria-label="Search events" /></label>
    </div>
    {error && <p className="cinema-error" role="alert">{error}</p>}
    {loading ? <div className="cinema-event-grid" aria-label="Loading events">{[1,2,3].map((key) => <div className="cinema-event-card is-loading" key={key} />)}</div>
      : visible.length ? <div className="cinema-event-grid">{visible.map((event) => <EventCard event={event} key={event.id} />)}</div>
      : <section className="cinema-card cinema-event-empty"><CalendarDots size={30} /><h3>No {section.toLowerCase()} events</h3><p>Try another section or search, or publish the first one.</p></section>}
    <CinemaDialog open={createOpen} busy={busy} title="Publish a Cinema event" onClose={() => setCreateOpen(false)}>
      <div className="cinema-create cinema-event-form">
        <div className="cinema-form-pair"><label>Organizer name<input value={form.organizerName} maxLength={100} placeholder="UMaT Robotics Club" onChange={(e) => setForm({ ...form, organizerName: e.target.value })} /></label><label>Organizer type<select value={form.organizerType} onChange={(e) => setForm({ ...form, organizerType: e.target.value })}><option value="CLUB">Club</option><option value="DEPARTMENT">Department</option><option value="STUDENT_GROUP">Student group</option></select></label></div>
        {form.organizerType !== "STUDENT_GROUP" && <div className="cinema-note">{organization?.status === "ACTIVE" ? "This organizer is approved for your account." : <><span>{organization?.status === "PENDING" ? "Staff are reviewing your request. You can update the affiliation reference while it is pending." : organization?.status === "REJECTED" ? "This request was rejected. You may submit it again after resolving the issue with Cinema staff." : "Club and department names need staff approval before you publish."}</span><label>Your role and affiliation reference<textarea rows={3} maxLength={500} value={affiliation} onChange={(e) => setAffiliation(e.target.value)} placeholder="Your role, adviser or department contact, and how staff can verify it" /></label><button type="button" disabled={busy || form.organizerName.trim().length < 2 || affiliation.trim().length < 10} onClick={() => void requestApproval()}>{organization?.status === "PENDING" ? "Update reference" : organization?.status === "REJECTED" ? "Request review again" : "Request approval"}</button></>}</div>}
        <label>Event format<select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value, capacity: "100" })}><option value="SCREENING">Screening or tutorial</option><option value="DEBATE">Student debate</option><option value="PANEL">Panel discussion</option></select></label>
        <label>Event title<input value={form.title} maxLength={80} placeholder="Weekly calculus tutorial" onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label>What students can expect<textarea value={form.description} maxLength={1200} rows={4} placeholder="Topics, speakers and what to bring…" onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>{form.format === "SCREENING" ? "YouTube link" : "Public YouTube live broadcast link"}<input value={form.video} placeholder="https://youtu.be/…" onChange={(e) => setForm({ ...form, video: e.target.value })} />{form.format !== "SCREENING" && <small>The audience watches this feed. Set up your stage broadcast before publishing; the room call alone does not broadcast speakers to the full audience.</small>}</label>
        <div className="cinema-form-pair"><label>First session<input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></label><label>Length<select value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}><option value="30">30 minutes</option><option value="60">1 hour</option><option value="90">90 minutes</option><option value="120">2 hours</option></select></label></div>
        <div className="cinema-form-pair"><label>Repeat weekly<select value={form.recurrenceCount} onChange={(e) => setForm({ ...form, recurrenceCount: e.target.value })}>{[1,2,3,4,6,8].map((count) => <option value={count} key={count}>{count === 1 ? "One event" : `${count} sessions`}</option>)}</select></label><label>{form.format === "SCREENING" ? "Attendance limit" : "Audience threshold"}<input type="number" min={form.format === "SCREENING" ? "1" : "10"} max="100" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /><small>{form.format === "SCREENING" ? "Choose 1–100 viewers. Reservations close when full." : "Choose 10–100. When full, verified accounts join a waitlist."}</small></label></div>
        {form.format !== "SCREENING" && <label>Stage places<select value={form.stageLimit} onChange={(e) => setForm({ ...form, stageLimit: e.target.value })}>{[2,3,4,5,6].map((count) => <option key={count} value={count}>{count} speakers</option>)}</select><small>The host uses one place and controls who may speak.</small></label>}
        <label className="cinema-file-label">Event poster<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPoster(e.target.files?.[0] || null)} /><small>JPG, PNG or WebP · up to 6 MB</small></label>
        <label className="cinema-check"><input type="checkbox" checked={form.certificatesEnabled} onChange={(e) => setForm({ ...form, certificatesEnabled: e.target.checked })} /><span><strong>Issue attendance certificates</strong><small>Attendees need sustained live presence, about half the session (10–30 minutes), before a certificate is issued.</small></span></label>
        {error && <p className="cinema-error">{error}</p>}
        <button disabled={busy || needsApproval || !form.title.trim() || !form.organizerName.trim() || !form.video.trim() || !form.startsAt} onClick={() => void create()}>{busy ? "Publishing…" : Number(form.recurrenceCount) > 1 ? `Publish ${form.recurrenceCount} sessions` : "Publish event"}</button>
      </div>
    </CinemaDialog>
  </div>;
}

function EventCard({ event }: { event: CinemaEvent }) {
  return <article className="cinema-event-card">
    <Link className="cinema-event-poster" href={`/cinema/events/${event.slug}`} style={event.posterUrl ? { backgroundImage: `url(${event.posterUrl})` } : undefined}>{!event.posterUrl && <FilmSlate size={38} />}<span className={`cinema-event-state is-${event.state.toLowerCase()}`}>{event.state === "LIVE" ? "Live now" : event.state === "REPLAY" ? "Replay" : dateBadge(event.startsAt)}</span></Link>
    <div className="cinema-event-copy"><span className="cinema-event-organizer">{event.organizer.name} · {event.format === "SCREENING" ? event.organizer.type.replace("_", " ").toLowerCase() : event.format === "DEBATE" ? "Student debate" : "Panel discussion"}</span><h3><Link href={`/cinema/events/${event.slug}`}>{event.title}</Link></h3><p>{event.description || "Open the event page for session details."}</p><div className="cinema-event-meta"><span><Ticket size={15} /> {event.capacity ? `${event.rsvpCount}/${event.capacity} going` : `${event.rsvpCount} going`}</span>{event.waitlistCount > 0 && <span>{event.waitlistCount} waiting</span>}{event.certificatesEnabled && <span><SealCheck size={15} /> Certificate</span>}{event.ratingCount > 0 && <span><Star size={15} /> {event.averageRating}</span>}{event.recurrenceCount > 1 && <span><UsersThree size={15} /> {event.recurrenceIndex}/{event.recurrenceCount}</span>}</div></div>
  </article>;
}

function dateBadge(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Upcoming" : date.toLocaleDateString([], { month: "short", day: "numeric" }); }
