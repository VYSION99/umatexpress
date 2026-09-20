"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCircle2, Loader2, MessageSquare, Phone, RotateCcw, Send, Star, Wrench } from "lucide-react";
import { Stars } from "./PropertyReviews";
import { cedis } from "./format";
import { subscribeToHostelThread } from "./message-stream-client";

type Booking = {
  id: string; reference: string; propertyName: string; propertyAddress: string;
  roomLabel: string; spaceLabel: string; periodName: string;
  landlordName: string; landlordPhone: string; landlordEmail: string;
  price: number; utilitiesFee: number; totalAmount: number;
  status: string; paidAt: string; holdExpiresAt: string; note: string; createdAt: string;
};

type Subscription = {
  id: string; pluginId: string; pluginName: string; pluginCategory: string;
  residentPrice: number; status: string;
};

type ServiceRequest = {
  id: string; pluginId: string; pluginName: string; pluginCategory: string;
  price: number; note: string; status: string; createdAt: string;
};

type Review = { id: string; rating: number; title: string; body: string; createdAt: string; reply: string; repliedAt: string };
type Refund = {
  id: string; amount: number; policy: string; percent: number; status: string;
  reason: string; overrideReason: string; providerStatus: string; createdAt: string; decidedAt: string; settledAt: string;
};
type RefundQuote = { policy: string; percent: number; amount: number; daysBeforeStart: number; note: string; canRequest: boolean; blockedReason: string };
type Residency = {
  booking: Booking; plugins: Subscription[]; services: ServiceRequest[]; unreadMessages: number;
  review: Review | null; refund: Refund | null; refundQuote: RefundQuote | null;
};
type Announcement = { id: string; propertyName: string; authorName: string; title: string; body: string; createdAt: string };
type Message = { id: string; senderType: string; senderName: string; content: string; createdAt: string };

const OPEN_SERVICE_STATUSES = ["REQUESTED", "APPROVED", "ACTIVE"];
const TERMINAL = ["EXPIRED", "CANCELLED", "REFUNDED"];
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

const statusLabel: Record<string, string> = {
  PAID: "Bed paid",
  PAYMENT_REVIEW: "Payment under review",
  REQUESTED: "Asked",
  APPROVED: "Approved",
  DECLINED: "Declined",
  REFUNDED: "Refunded",
  FAILED: "Failed",
  ACTIVE: "Running",
  COMPLETED: "Done",
  CANCELLED: "Cancelled",
};

/**
 * The resident page after the money lands.
 *
 * One card per paid booking: the bed, the host's own phone number, the services
 * the hostel switched on with the price this student pays, and a thread with
 * the landlord that both sides read from the same durable history.
 */
export function ResidentDashboard() {
  const [residencies, setResidencies] = useState<Residency[] | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/hostel/bookings", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { residencies?: Residency[]; announcements?: Announcement[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Your residency could not be loaded.");
      setResidencies(data.residencies || []);
      setAnnouncements(data.announcements || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your residency could not be loaded.");
      setResidencies([]);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  // The counterpart writes from the console, so the page refreshes on its own
  // while it is open rather than asking the student to reload.
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 45_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const requestService = async (reference: string, pluginId: string) => {
    setBusy(`service:${pluginId}`);
    setError("");
    try {
      const response = await fetch("/api/hostel/services", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference, pluginId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That service could not be requested.");
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "That service could not be requested.");
    } finally {
      setBusy("");
    }
  };

  if (!residencies) return <p className="hostel-resident-loading"><Loader2 size={16} className="console-spin" aria-hidden /> Loading your residency…</p>;

  if (!residencies.length) {
    return <section className="hostel-empty">
      <AlertTriangle size={26} aria-hidden />
      <h2>No paid bed on this account yet</h2>
      <p>Once a hostel payment is confirmed, your bed, your host&apos;s number and the services you asked for appear here.</p>
      {error && <p className="hostel-book-error">{error}</p>}
      <Link href="/hostel" className="hostel-card-link">Browse hostels</Link>
    </section>;
  }

  return <div className="hostel-resident">
    {error && <p className="hostel-resident-error">{error}</p>}
    {announcements.length > 0 && <section className="hostel-resident-notices">
      <p><Bell size={14} aria-hidden /> FROM YOUR HOSTEL</p>
      <ul>
        {announcements.map((notice) => <li key={notice.id}>
          <strong>{notice.title}</strong>
          <span>{notice.body}</span>
          <small>{notice.propertyName || "Your hostel"} · {notice.authorName || "Manager"} · {when(notice.createdAt)}</small>
        </li>)}
      </ul>
    </section>}
    {residencies.map((residency) => <ResidencyCard
      key={residency.booking.id}
      residency={residency}
      busy={busy}
      onRequest={requestService}
      onRefresh={load}
    />)}
  </div>;
}

function ResidencyCard({ residency, busy, onRequest, onRefresh }: {
  residency: Residency;
  busy: string;
  onRequest: (reference: string, pluginId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { booking, plugins, services } = residency;
  const [thread, setThread] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [rating, setRating] = useState(0);
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [savingReview, setSavingReview] = useState(false);
  const [refundReason, setRefundReason] = useState("");
  const [refundError, setRefundError] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);

  /** A cancellation is a request, not a transfer: an administrator still decides. */
  async function requestRefund(event: FormEvent) {
    event.preventDefault();
    setRefundBusy(true);
    setRefundError("");
    try {
      const response = await fetch("/api/hostel/refunds", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: booking.reference, reason: refundReason }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That cancellation was not recorded.");
      setRefundReason("");
      await onRefresh();
    } catch (refundSubmitError) {
      setRefundError(refundSubmitError instanceof Error ? refundSubmitError.message : "That cancellation was not recorded.");
    } finally {
      setRefundBusy(false);
    }
  }

  /** One review per paid stay: the server refuses a second, so the box goes away with it. */
  async function submitReview(event: FormEvent) {
    event.preventDefault();
    setSavingReview(true);
    setReviewError("");
    try {
      const response = await fetch("/api/hostel/reviews", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingReference: booking.reference, rating, title: reviewTitle, body: reviewBody }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That review was not saved.");
      await onRefresh();
    } catch (submitError) {
      setReviewError(submitError instanceof Error ? submitError.message : "That review was not saved.");
    } finally {
      setSavingReview(false);
    }
  }

  const latestMessageId = useRef("");
  const loadThread = useCallback(async () => {
    setThreadError("");
    try {
      const response = await fetch(`/api/hostel/messages?reference=${encodeURIComponent(booking.reference)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The thread could not be loaded.");
      latestMessageId.current = data.messages?.at(-1)?.id || "";
      setThread(data.messages || []);
    } catch (threadLoadError) {
      setThreadError(threadLoadError instanceof Error ? threadLoadError.message : "The thread could not be loaded.");
    }
  }, [booking.reference]);

  // While the thread is open the server pushes a change event the moment the
  // host writes, so the reply appears without waiting for the 45-second sweep.
  const threadOpen = thread !== null;
  useEffect(() => {
    if (!threadOpen) return;
    const after = encodeURIComponent(latestMessageId.current);
    return subscribeToHostelThread(`/api/hostel/messages/stream?reference=${encodeURIComponent(booking.reference)}&after=${after}`, () => {
      void loadThread();
    });
  }, [threadOpen, loadThread, booking.reference]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    setThreadError("");
    try {
      const response = await fetch("/api/hostel/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: booking.reference, content: draft }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That message was not sent.");
      setDraft("");
      await loadThread();
      await onRefresh();
    } catch (sendError) {
      setThreadError(sendError instanceof Error ? sendError.message : "That message was not sent.");
    } finally {
      setSending(false);
    }
  };

  const openStatusFor = (pluginId: string) => services.find((service) => service.pluginId === pluginId && OPEN_SERVICE_STATUSES.includes(service.status));
  const lastServiceFor = (pluginId: string) => services
    .filter((service) => service.pluginId === pluginId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  return <article className="hostel-resident-card">
    <header>
      <div>
        <p>YOUR RESIDENCY</p>
        <h2>{booking.propertyName}</h2>
        <span>{booking.roomLabel}{booking.spaceLabel ? ` · ${booking.spaceLabel}` : ""} · {booking.periodName}</span>
      </div>
      <span className={`hostel-resident-chip hostel-resident-chip-${booking.status.toLowerCase()}`}>
        {booking.status === "PAID" ? <CheckCircle2 size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
        {statusLabel[booking.status] || booking.status}
      </span>
    </header>

    <ul className="hostel-resident-facts">
      <li><span>Paid</span><strong>{cedis(booking.totalAmount)}</strong></li>
      <li><span>Rent</span><strong>{cedis(booking.price)}</strong></li>
      {booking.utilitiesFee > 0 && <li><span>Utilities</span><strong>{cedis(booking.utilitiesFee)}</strong></li>}
      <li><span>Confirmed</span><strong>{when(booking.paidAt) || "Being reviewed"}</strong></li>
      <li><span>Reference</span><strong>{booking.reference}</strong></li>
    </ul>

    <section className="hostel-resident-host">
      <p>YOUR HOST</p>
      <strong>{booking.landlordName || "Hostel office"}</strong>
      <span>{booking.propertyAddress || "Address shared by your host"}</span>
      <div>
        {booking.landlordPhone && <a href={`tel:${booking.landlordPhone}`}><Phone size={13} aria-hidden />{booking.landlordPhone}</a>}
        {booking.landlordEmail && <a href={`mailto:${booking.landlordEmail}`}>{booking.landlordEmail}</a>}
      </div>
    </section>

    <section className="hostel-resident-services">
      <p><Wrench size={14} aria-hidden /> SERVICES YOUR HOSTEL OFFERS</p>
      {plugins.length === 0
        ? <span className="hostel-resident-muted">Your hostel has not switched on any extra services for {booking.periodName}.</span>
        : <div className="hostel-resident-plugin-grid">
          {plugins.map((plugin) => {
            const open = openStatusFor(plugin.pluginId);
            const last = lastServiceFor(plugin.pluginId);
            return <div key={plugin.id} className="hostel-resident-plugin">
              <strong>{plugin.pluginName}</strong>
              <small>{plugin.pluginCategory.toLowerCase()} · {plugin.residentPrice > 0 ? `${cedis(plugin.residentPrice)} a year` : "included in your rent"}</small>
              {open
                ? <span className="hostel-resident-service-state">{statusLabel[open.status] || open.status}{open.price > 0 ? ` · ${cedis(open.price)}` : ""}</span>
                : TERMINAL.includes(booking.status)
                  ? <span className="hostel-resident-muted">This stay is closed.</span>
                  : <button
                    type="button"
                    className="hostel-resident-service-button"
                    onClick={() => void onRequest(booking.reference, plugin.pluginId)}
                    disabled={busy === `service:${plugin.pluginId}`}
                  >
                    {busy === `service:${plugin.pluginId}` ? <Loader2 size={13} className="console-spin" aria-hidden /> : null}
                    {last && !OPEN_SERVICE_STATUSES.includes(last.status) ? "Ask again" : "Ask for this"}
                  </button>}
              {last && !open && <small className="hostel-resident-muted">Last: {statusLabel[last.status] || last.status} · {when(last.createdAt)}</small>}
            </div>;
          })}
        </div>}
    </section>

    <section className="hostel-resident-review">
      <p><Star size={13} aria-hidden /> YOUR REVIEW</p>
      {residency.review
        ? <div className="hostel-resident-review-saved">
          <Stars rating={residency.review.rating} />
          <strong>{residency.review.title || `${residency.review.rating} out of 5`}</strong>
          <span>{residency.review.body}</span>
          {residency.review.reply && <div className="hostel-resident-review-reply">
            <strong>The hostel replied</strong>
            <span>{residency.review.reply}</span>
          </div>}
        </div>
        : booking.status === "PAID"
          ? <form onSubmit={submitReview}>
            <div className="hostel-review-picker" role="radiogroup" aria-label="Your rating">
              {[1, 2, 3, 4, 5].map((step) => <button
                key={step}
                type="button"
                role="radio"
                aria-checked={rating === step}
                aria-label={`${step} ${step === 1 ? "star" : "stars"}`}
                className={step <= rating ? "is-on" : ""}
                onClick={() => setRating(step)}
              ><Star size={18} aria-hidden /></button>)}
            </div>
            <input value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} placeholder="A headline (optional)" maxLength={120} />
            <textarea value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="What were the room, the water, the gate like?" maxLength={1500} rows={3} />
            <button type="submit" disabled={savingReview || !rating || !reviewBody.trim()}>
              {savingReview ? <Loader2 size={14} className="console-spin" aria-hidden /> : <Star size={14} aria-hidden />} Post review
            </button>
            {reviewError && <span className="hostel-book-error">{reviewError}</span>}
          </form>
          : <span className="hostel-resident-muted">{TERMINAL.includes(booking.status) ? "This stay is closed, so there is no review to leave." : "A review opens once the bed is paid."}</span>}
    </section>

    <section className="hostel-resident-refund">
      <p><RotateCcw size={13} aria-hidden /> CANCELLING THIS BED</p>
      {residency.refund
        ? <div className="hostel-resident-refund-state">
          <span className={`hostel-resident-refund-chip hostel-resident-refund-${residency.refund.status.toLowerCase()}`}>
            {statusLabel[residency.refund.status] || residency.refund.status}
          </span>
          <strong>{cedis(residency.refund.amount)}</strong>
          <span>
            {residency.refund.policy === "OVERRIDE"
              ? `An administrator set this at ${residency.refund.percent}%${residency.refund.overrideReason ? ` — ${residency.refund.overrideReason}` : ""}`
              : `Policy: ${residency.refund.percent}% returned`}
          </span>
          {residency.refund.status === "DECLINED" && residency.refund.providerStatus && <span>Reason: {residency.refund.providerStatus}</span>}
          {residency.refund.status === "APPROVED" && <span>The money is with Paystack and will land in your account shortly.</span>}
          <small>Asked {when(residency.refund.createdAt)}{residency.refund.settledAt ? ` · settled ${when(residency.refund.settledAt)}` : ""}</small>
        </div>
        : residency.refundQuote?.canRequest
          ? <form onSubmit={requestRefund}>
            <p className="hostel-resident-refund-quote">
              Cancel today and <strong>{cedis(residency.refundQuote.amount)}</strong> comes back — {residency.refundQuote.percent}% of what you paid.
            </p>
            <small>{residency.refundQuote.note}</small>
            <textarea
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
              placeholder="Why are you cancelling? (optional, but it helps the office decide)"
              maxLength={500}
              rows={2}
            />
            <button type="submit" disabled={refundBusy}>
              {refundBusy ? <Loader2 size={14} className="console-spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />} Ask to cancel and refund
            </button>
            <small className="hostel-resident-muted">The bed stays yours until an administrator approves, and the money moves after that.</small>
            {refundError && <span className="hostel-book-error">{refundError}</span>}
          </form>
          : <span className="hostel-resident-muted">
            {residency.refundQuote?.blockedReason || "There is nothing to refund on this booking."}
            {residency.refundQuote && residency.refundQuote.daysBeforeStart > 0 && ` The year starts in ${residency.refundQuote.daysBeforeStart} day${residency.refundQuote.daysBeforeStart === 1 ? "" : "s"}.`}
          </span>}
    </section>

    <section className="hostel-resident-thread">
      <button type="button" className="hostel-resident-thread-toggle" onClick={() => { if (thread === null) void loadThread(); else setThread(null); }}>
        <MessageSquare size={15} aria-hidden />
        {thread === null ? "Open the thread with your host" : "Hide the thread"}
        {residency.unreadMessages > 0 && <span className="hostel-resident-unread">{residency.unreadMessages}</span>}
      </button>
      {thread !== null && <div className="hostel-resident-thread-body">
        {thread.length === 0
          ? <span className="hostel-resident-muted">No messages yet. Ask about the room, the gate or the water.</span>
          : <ul>
            {thread.map((message) => <li key={message.id} className={message.senderType === "STUDENT" ? "is-mine" : message.senderType === "SYSTEM" ? "is-system" : ""}>
              <strong>{message.senderName || (message.senderType === "STUDENT" ? "You" : "Host")}</strong>
              <span>{message.content}</span>
              <small>{new Date(message.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
            </li>)}
          </ul>}
        {TERMINAL.includes(booking.status)
          ? <span className="hostel-resident-muted">This booking is closed, so the thread is read-only.</span>
          : <form onSubmit={send}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write to your host…" maxLength={2000} rows={3} />
            <button type="submit" disabled={sending || !draft.trim()}>
              {sending ? <Loader2 size={14} className="console-spin" aria-hidden /> : <Send size={14} aria-hidden />} Send
            </button>
          </form>}
        {threadError && <span className="hostel-book-error">{threadError}</span>}
      </div>}
    </section>
  </article>;
}
