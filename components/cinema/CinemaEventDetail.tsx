"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarDots, CheckCircle, Copy, FilmSlate, SealCheck, ShareNetwork, Star, Ticket, UsersThree } from "@/components/ui/MaterialIcon";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaEvent } from "@/lib/cinema-engine/events";
import "./cinema.css";

export function CinemaEventDetail({ id }: { id: string }) {
  const { account } = useStudentAccount(); const [event, setEvent] = useState<CinemaEvent | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState(5); const [comment, setComment] = useState(""); const [feedbackSent, setFeedbackSent] = useState(false);
  const [watchReplay, setWatchReplay] = useState(false);
  useEffect(() => { let live = true; fetch(`/api/cinema/events/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" }).then(async (response) => { const data = await response.json() as { event?: CinemaEvent; error?: string }; if (!response.ok || !data.event) throw new Error(data.error || "This event could not be loaded."); if (live) setEvent(data.event); }).catch((problem) => { if (live) setError(problem instanceof Error ? problem.message : "This event could not be loaded."); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [id, account?.id]);
  const act = async (action: "RSVP" | "CANCEL_RSVP" | "FEEDBACK") => {
    setBusy(true); setError("");
    try { const response = await fetch(`/api/cinema/events/${event?.id || id}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, rating, comment }) }); const data = await response.json() as { event?: CinemaEvent; error?: string }; if (!response.ok || !data.event) throw new Error(data.error || "That action could not be completed."); setEvent(data.event); if (action === "FEEDBACK") setFeedbackSent(true); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "That action could not be completed."); } finally { setBusy(false); }
  };
  const share = async () => { const url = location.href; if (navigator.share) { await navigator.share({ title: event?.title, text: event?.description, url }).catch(() => undefined); return; } await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); };
  if (loading) return <section className="cinema-card"><p className="cinema-note">Loading event…</p></section>;
  if (!event) return <section className="cinema-card"><h2>Event unavailable</h2><p className="cinema-error">{error}</p><Link className="cinema-cta" href="/cinema/events">Browse events</Link></section>;
  const date = new Date(event.startsAt); const full = event.availablePlaces === 0 && event.viewerRsvp !== "GOING";
  const canWaitlist = full && event.format !== "SCREENING";
  return <article className="cinema-event-detail">
    <div className="cinema-event-detail-poster" style={event.posterUrl ? { backgroundImage: `url(${event.posterUrl})` } : undefined}>{!event.posterUrl && <FilmSlate size={72} />}<span className={`cinema-event-state is-${event.state.toLowerCase()}`}>{event.state === "LIVE" ? "Live now" : event.state === "REPLAY" ? "Replay available" : "Upcoming"}</span></div>
    <section className="cinema-event-detail-copy">
      <span className="cinema-event-organizer">{event.format === "DEBATE" ? "Student debate" : event.format === "PANEL" ? "Panel discussion" : "Cinema event"} · Presented by {event.organizer.name}</span><h1>{event.title}</h1><p className="cinema-event-description">{event.description || "The organizer has not added a description yet."}</p>
      <dl className="cinema-event-facts"><div><dt><CalendarDots size={18} /> Date and time</dt><dd>{Number.isNaN(date.getTime()) ? "To be announced" : date.toLocaleString([], { dateStyle: "full", timeStyle: "short" })}</dd></div><div><dt><Ticket size={18} /> Attendance</dt><dd>{event.capacity ? `${event.rsvpCount} going · ${event.availablePlaces} places left` : `${event.rsvpCount} going · no attendance limit`}{event.waitlistCount > 0 ? ` · ${event.waitlistCount} waiting` : ""}</dd></div>{event.format !== "SCREENING" && <div><dt><UsersThree size={18} /> Speaking stage</dt><dd>Up to {event.stageLimit} speakers; the host approves stage access.</dd></div>}{event.recurrenceCount > 1 && <div><dt><UsersThree size={18} /> Weekly series</dt><dd>Session {event.recurrenceIndex} of {event.recurrenceCount}</dd></div>}{event.certificatesEnabled && <div><dt><SealCheck size={18} /> Certificate</dt><dd>Issued after verified attendance</dd></div>}</dl>
      <div className="cinema-event-actions">
        {event.state !== "REPLAY" && (account ? event.viewerRsvp === "GOING" ? <><Link className="cinema-cta" href={`/cinema/${event.sessionId}`}>{event.state === "LIVE" ? "Join live event" : "Open reserved room"}</Link><button className="secondary" disabled={busy} onClick={() => void act("CANCEL_RSVP")}><CheckCircle size={18} /> Going · cancel RSVP</button></> : event.viewerRsvp === "WAITLIST" ? <><span role="status">You are #{event.waitlistPosition} on the waitlist.</span><button className="secondary" disabled={busy} onClick={() => void act("CANCEL_RSVP")}>Leave waitlist</button></> : account.emailVerified ? <button disabled={busy || (full && !canWaitlist)} onClick={() => void act("RSVP")}>{canWaitlist ? "Join waitlist" : full ? "Event is full" : "Reserve my place"}</button> : <Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/events/${event.slug}`)}`}>Verify email to RSVP</Link> : <Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/events/${event.slug}`)}`}>Sign in to RSVP</Link>)}
        {event.state === "REPLAY" && event.replayVideoId && <button onClick={() => setWatchReplay(true)}>Watch session video</button>}
        {event.state === "REPLAY" && <Link className="secondary cinema-button-link" href={`/cinema/${event.sessionId}`}>Open session archive</Link>}
        <button className="secondary" onClick={() => void share()}>{copied ? <Copy size={18} /> : <ShareNetwork size={18} />}{copied ? "Link copied" : "Share event"}</button>
      </div>
      {event.format !== "SCREENING" && <p className="cinema-note">The audience watches a separate YouTube broadcast. The host must connect the speakers to that feed; the speaking-stage call does not broadcast automatically. The attendance limit applies inside UMaTeXPRESS, while anyone with the YouTube link may be able to watch there.</p>}
      {error && <p className="cinema-error" role="alert">{error}</p>}
      {event.state === "REPLAY" && watchReplay && event.replayVideoId && <div className="cinema-event-replay"><iframe src={`https://www.youtube-nocookie.com/embed/${event.replayVideoId}`} title={`${event.title} session video`} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen loading="lazy" /><p>This is the video used in the session. Live discussion and calls are not recorded here.</p></div>}
      {event.state === "REPLAY" && account && <section className="cinema-event-after"><h2>After the session</h2>{event.certificatesEnabled && <a className="secondary cinema-button-link" href={`/api/cinema/events/${event.id}/certificate`}><SealCheck size={18} /> Download attendance certificate</a>}<div className="cinema-feedback"><h3>Rate this event</h3>{feedbackSent ? <p><CheckCircle size={17} /> Thanks—your feedback has been recorded.</p> : <><div className="cinema-rating" role="radiogroup" aria-label="Event rating">{[1,2,3,4,5].map((value) => <button key={value} role="radio" aria-checked={rating === value} aria-label={`${value} stars`} onClick={() => setRating(value)}><Star size={24} weight={value <= rating ? "fill" : "regular"} /></button>)}</div><textarea rows={3} maxLength={600} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What worked well? What should change?" /><button disabled={busy} onClick={() => void act("FEEDBACK")}>Send feedback</button></>}</div></section>}
    </section>
  </article>;
}
