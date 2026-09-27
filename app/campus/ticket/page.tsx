"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle, Circle, CircleNotch, Clock, ImageSquare, MapPin, ShareNetwork, ShieldCheck, Trash, WifiSlash, XCircle } from "@phosphor-icons/react";
import { TripFeedback } from "@/components/campusRide/student/TripFeedback";
import { queueProgress } from "@/lib/campus-engine/progress";
import { forgetTicket, rememberTicket } from "@/lib/passenger-profile";

/**
 * What `verifyCampusRidePayment` returns for `ticket`. Named rather than left as
 * a loose record so a renamed column is a compile error instead of a blank line
 * on a passenger's ticket. The zone and corridor names come from left joins and
 * can be absent.
 */
type Ticket = {
  reference: string;
  passenger_name: string;
  phone: string;
  email: string;
  queue_position: number;
  amount: number;
  payment_status: string;
  queue_status: string;
  ride_pin: string;
  created_at: string;
  payment_reference: string;
  ride_id: string;
  driver_name: string;
  vehicle_label: string;
  plate_number: string;
  pickup_zone: string | null;
  destination_zone: string | null;
  corridor_name: string | null;
};

type QueueStatus = {
  status: string;
  queuePosition: number;
  peopleAhead: number | null;
  estimatedWaitMinutes: number | null;
  waitLabel: string | null;
  progress: ReturnType<typeof queueProgress>;
  route: { pickupZone: string; destinationZone: string; corridorName: string };
  driver: { name: string; vehicleLabel: string; plateNumber: string; zoneName: string };
  pickupEta?: { minutes: number | null; label: string; source: string; distanceKm: number | null; note: string } | null;
  cancellation?: { tier: "FULL" | "NONE"; amount: number; canCancel: boolean; blockedReason: string; note: string } | null;
  refund?: { id: string; amount: number; status: string; cause: string; settledAt: string; createdAt: string } | null;
  updatedAt: string;
};

function cedisFromPesewas(pesewas: number) {
  return `GH₵ ${(Math.max(0, Number(pesewas) || 0) / 100).toFixed(2)}`;
}

/**
 * What the refund line says at each stage. The wording leans on days rather
 * than hours because the rail, not the platform, decides when a card or wallet
 * shows the money, and a passenger who is told "today" and sees it tomorrow
 * trusts the next message less.
 */
function refundLine(refund: { amount: number; status: string; cause: string }) {
  const amount = cedisFromPesewas(refund.amount);
  if (refund.status === "PAID") return `${amount} refunded. It may take a few days to appear on your statement.`;
  if (refund.status === "APPROVED") return `${amount} refund sent — usually within 3–5 working days.`;
  if (refund.status === "FAILED" || refund.status === "DECLINED") return `${amount} refund needs a hand from support. We have the record.`;
  return `${amount} refund requested. It is being processed.`;
}

const CACHE_PREFIX = "umx_campus_ticket_";
const POLL_MS = 15_000;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const PENDING_POLL_MS = 5_000;
const PENDING_MAX_ATTEMPTS = 120;

function cacheKey(reference: string) {
  return `${CACHE_PREFIX}${reference}`;
}

function clearCachedTicket(reference: string) {
  try { window.localStorage.removeItem(cacheKey(reference)); } catch { /* storage unavailable */ }
}

function readCachedTicket(reference: string) {
  try {
    const cached = JSON.parse(window.localStorage.getItem(cacheKey(reference)) || "null") as { ticket?: Ticket; savedAt?: string } | null;
    const savedAt = Date.parse(cached?.savedAt || "");
    // A stale boarding PIN is worthless, so an expired cache is discarded.
    if (!cached?.ticket || !Number.isFinite(savedAt) || Date.now() - savedAt > CACHE_TTL_MS) {
      clearCachedTicket(reference);
      return null;
    }
    return { ticket: cached.ticket, savedAt: cached.savedAt || "" };
  } catch {
    return null;
  }
}

export default function CampusTicketPage() {
  const [state, setState] = useState<"loading" | "paid" | "pending" | "failed" | "signin">("loading");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signInHref, setSignInHref] = useState("/account");
  // Cancelling is two taps rather than one: the first opens the policy in full,
  // the second gives up the seat, so nobody loses a ride to a stray touch.
  const [cancelStep, setCancelStep] = useState<"idle" | "confirm" | "working">("idle");
  const referenceRef = useRef("");

  // Progress is derived from the last poll, falling back to the ticket's own
  // status so the timeline renders even before the first refresh lands.
  const progress = useMemo(() => status?.progress || queueProgress(String(ticket?.queue_status || "PAID_WAITING")), [status, ticket]);

  const applyVerified = useCallback((reference: string, data: { paid?: boolean; status?: string; ticket?: Ticket }) => {
    const paid = Boolean(data.paid);
    setTicket(data.ticket || null);
    setState(paid ? "paid" : data.status === "FAILED" ? "failed" : "pending");
    if (paid && data.ticket) {
      try { window.localStorage.setItem(cacheKey(reference), JSON.stringify({ ticket: data.ticket, savedAt: new Date().toISOString() })); } catch { /* storage unavailable */ }
      // So the passenger can find this ticket again from the profile panel.
      rememberTicket({ reference, kind: "campus" });
    }
  }, []);

  const verify = useCallback(async (reference: string, allowCache: boolean) => {
    try {
      const response = await fetch(`/api/campus/queue/verify?reference=${encodeURIComponent(reference)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      // A deep link opened by someone who is not signed in as the queue
      // entry's owner: offer the account handoff instead of a dead end.
      if (response.status === 403) { setState("signin"); return; }
      if (!response.ok) throw new Error(data.error || "campusRide payment verification failed.");
      applyVerified(reference, data);
    } catch (verifyError) {
      // No network at the gate? Show the ticket this device already saved.
      const cached = allowCache ? readCachedTicket(reference) : null;
      if (cached) { setTicket(cached.ticket); setCachedAt(cached.savedAt); setOffline(true); setState("paid"); return; }
      setError(verifyError instanceof Error ? verifyError.message : "campusRide payment verification failed.");
      setState("failed");
    }
  }, [applyVerified]);

  const loadStatus = useCallback(async () => {
    const reference = referenceRef.current;
    if (!reference) return;
    try {
      const response = await fetch(`/api/campus/queue/status?reference=${encodeURIComponent(reference)}`, { credentials: "same-origin", cache: "no-store" });
      // A rejected token must not blank out a ticket the passenger already holds.
      if (!response.ok) return;
      const payload = await response.json() as QueueStatus;
      setStatus(payload);
      setOffline(false);
      // The ride is over, so the cached boarding PIN is no longer needed.
      if (payload.progress?.state === "terminal") clearCachedTicket(reference);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      const reference = new URLSearchParams(window.location.search).get("reference") || "";
      referenceRef.current = reference;
      if (!reference) { setState("failed"); setError("Missing campusRide payment reference."); return; }
      // After signing in, the student lands back on this exact ticket.
      setSignInHref(`/account?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
      void verify(reference, true);
    });
  }, [verify]);

  // The ticket goes live the moment Paystack settles, so keep checking rather
  // than asking the passenger to refresh the page.
  useEffect(() => {
    if (state !== "pending") return;
    const reference = referenceRef.current;
    if (!reference) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > PENDING_MAX_ATTEMPTS) { window.clearInterval(timer); return; }
      void verify(reference, false);
    }, PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [state, verify]);

  // One ETA line, in order of how much the passenger can trust it: a live
  // driver beats a queue-batch estimate, and the estimate beats nothing.
  const pickupEta = status?.pickupEta || null;
  const etaLine = pickupEta?.label
    ? { value: pickupEta.label, hint: pickupEta.source === "AT_PICKUP" ? "Meet your driver at the pickup zone" : "Your driver is on the way" }
    : status?.waitLabel
      ? { value: status.waitLabel, hint: status.peopleAhead === 0 ? "You are next" : `${status.peopleAhead ?? 0} ahead of you` }
      : null;

  // Stop polling once the ride reaches a terminal state.
  const tracking = state === "paid" && progress.state === "active";
  useEffect(() => {
    if (!tracking) return;
    void loadStatus();
    const timer = window.setInterval(() => { void loadStatus(); }, POLL_MS);
    const refresh = () => { if (document.visibilityState === "visible") void loadStatus(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [tracking, loadStatus]);

  const saveImage = () => { window.print(); };

  const share = async () => {
    const reference = referenceRef.current;
    const pickup = status?.route.pickupZone || String(ticket?.pickup_zone || "campus");
    const destination = status?.route.destinationZone || String(ticket?.destination_zone || "");
    // Deliberately excludes the boarding PIN: this text may leave the device.
    const text = `campusRide ${pickup}${destination ? ` to ${destination}` : ""}. Reference ${reference}.`;
    try {
      if (navigator.share) { await navigator.share({ title: "campusRide ticket", text }); return; }
      await navigator.clipboard.writeText(text);
      setNotice("Trip details copied. Your boarding PIN was not included.");
      window.setTimeout(() => setNotice(""), 4000);
    } catch { /* the passenger dismissed the share sheet */ }
  };

  const cancelSeat = async () => {
    const reference = referenceRef.current;
    if (!reference) return;
    setCancelStep("working");
    try {
      const response = await fetch("/api/campus/queue/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ reference }),
      });
      const data = await response.json() as { refund?: { amount: number } | null; error?: string };
      if (!response.ok) throw new Error(data.error || "We could not cancel this seat.");
      setNotice(data.refund?.amount ? `Seat cancelled. ${cedisFromPesewas(data.refund.amount)} refund recorded.` : "Seat cancelled. Nothing was owed back.");
      setCancelStep("idle");
      await loadStatus();
      void verify(reference, false);
      window.setTimeout(() => setNotice(""), 6000);
    } catch (cancelError) {
      setNotice(cancelError instanceof Error ? cancelError.message : "We could not cancel this seat.");
      setCancelStep("idle");
      window.setTimeout(() => setNotice(""), 6000);
    }
  };

  const forget = () => {
    clearCachedTicket(referenceRef.current);
    forgetTicket(referenceRef.current);
    setNotice("Saved ticket removed from this device.");
    window.setTimeout(() => setNotice(""), 4000);
  };

  return <main className="payment-status-page campus-ticket-interface">
    {state === "loading" ? <><CircleNotch className="status-icon spin"/><h1>Verifying campusRide payment…</h1></> :
    state === "paid" && ticket ? <>
      {offline && <p className="campus-offline-banner"><WifiSlash size={16}/> Offline — showing the ticket saved on this device{cachedAt ? ` at ${new Date(cachedAt).toLocaleTimeString()}` : ""}.</p>}
      <section className="campus-live-progress" aria-live="polite">
        <div className="campus-live-head">
          <div><small>Live status</small><strong>{progress.label}</strong><span>{progress.hint}</span></div>
          {etaLine ? <div className="campus-live-eta">
            <Clock size={15}/>
            <b>{etaLine.value}</b>
            <small>{etaLine.hint}</small>
          </div> : null}
        </div>
        <ol className="campus-live-steps">
          {progress.steps.map((step) => <li key={step.key} className={`is-${step.state}`}>
            <span className="campus-live-dot">{step.state === "done" ? <CheckCircle size={16}/> : <Circle size={16}/>}</span>
            <div><strong>{step.label}</strong><small>{step.hint}</small></div>
          </li>)}
        </ol>
        {pickupEta?.note ? <p className="campus-live-note">{pickupEta.note}</p> : null}
        {status?.driver.name ? <p className="campus-live-driver">
          <MapPin size={15}/> <strong>{status.driver.name}</strong> · {status.driver.vehicleLabel} {status.driver.plateNumber}
          {status.driver.zoneName ? ` · near ${status.driver.zoneName}` : ""}
        </p> : null}
      </section>
      <div className="ticket-card campus-ticket-card">
        <div className="ticket-head"><div className="ticket-brand"><img src="/logo-mark.png" alt="" /><div><strong>campusRide</strong><small>{ticket.corridor_name || "Campus ride ticket"}</small></div></div><span>PAID</span></div>
        <div className="ticket-route"><strong>{ticket.pickup_zone}</strong><i>→</i><strong>{ticket.destination_zone}</strong></div>
        <div className="ticket-grid">
          <span><small>Passenger</small><strong>{ticket.passenger_name}</strong></span>
          <span><small>Phone</small><strong>{ticket.phone}</strong></span>
          <span><small>Queue position</small><strong>#{ticket.queue_position}</strong></span>
          <span><small>Boarding PIN</small><strong>{ticket.ride_pin}</strong></span>
          <span><small>Amount</small><strong>GH₵ {(Number(ticket.amount || 0)/100).toFixed(2)}</strong></span>
          <span><small>Driver</small><strong>{ticket.driver_name}</strong></span>
          <span><small>Vehicle</small><strong>{ticket.vehicle_label} {ticket.plate_number}</strong></span>
        </div>
        <div className="ticket-reference">
          <span><small>Ticket reference</small><strong>{ticket.reference}</strong></span>
          <small>Show this image ticket and PIN to the driver before boarding.</small>
        </div>
      </div>
      {status?.refund ? <p className={`campus-refund-line is-${String(status.refund.status).toLowerCase()}`}>
        <ShieldCheck size={16}/> {refundLine(status.refund)}
      </p> : null}
      {status?.cancellation?.canCancel ? <section className="campus-cancel-panel">
        <div>
          <strong>{status.cancellation.tier === "FULL" ? "Free to cancel" : "Cancel this seat"}</strong>
          <small>{status.cancellation.note}</small>
          {status.cancellation.tier === "FULL" && status.cancellation.amount > 0
            ? <small className="campus-cancel-amount">{cedisFromPesewas(status.cancellation.amount)} goes back to you.</small>
            : null}
        </div>
        {cancelStep === "idle" ? <button className="campus-cancel-button" onClick={() => setCancelStep("confirm")}>Cancel this seat</button>
        : <div className="campus-cancel-confirm">
          <p>{status.cancellation.tier === "FULL"
            ? `Give up this seat and refund ${cedisFromPesewas(status.cancellation.amount)}?`
            : "Give up this seat? The fare is kept because a driver has already taken it."}</p>
          <div>
            <button className="is-danger" onClick={cancelSeat} disabled={cancelStep === "working"}>
              {cancelStep === "working" ? <><CircleNotch size={15} className="spin"/> Cancelling…</> : "Yes, cancel"}
            </button>
            <button onClick={() => setCancelStep("idle")} disabled={cancelStep === "working"}>Keep my seat</button>
          </div>
        </div>}
      </section> : null}
      {status?.cancellation && !status.cancellation.canCancel && status.cancellation.blockedReason
        ? <p className="campus-ticket-notice">{status.cancellation.blockedReason}</p> : null}
      {status?.status === "COMPLETED" ? <TripFeedback reference={String(ticket.reference || "")} /> : null}
      {notice && <p className="campus-ticket-notice">{notice}</p>}
      <div className="ticket-actions">
        <button onClick={saveImage}><ImageSquare size={17}/> Save/print image</button>
        <button onClick={share}><ShareNetwork size={17}/> Share trip</button>
        <button onClick={forget}><Trash size={17}/> Forget ticket</button>
        <Link href="/campus">Find another ride</Link>
        <Link href="/">Client home</Link>
      </div>
    </> :
    state === "pending" ? <><CircleNotch className="status-icon spin"/><h1>Payment pending</h1><p>Your campusRide payment is not confirmed yet. Refresh this page after approval.</p><Link href="/campus">Return to campusRide</Link></> :
    state === "signin" ? <><ShieldCheck className="status-icon"/><h1>Sign in to open this ticket</h1><p>This ticket belongs to the UMaT account its queue entry was made under, not to this browser. Sign in with that account and the ticket opens right here.</p><Link href={signInHref}>Sign in to view ticket</Link></> :
    <><XCircle className="status-icon fail"/><h1>Payment not completed</h1><p>{error || "No confirmed campusRide payment was found."}</p><Link href="/campus">Try again</Link></>}
  </main>;
}
