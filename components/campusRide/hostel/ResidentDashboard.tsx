"use client";
import { StayPlansPanel } from "./StayPlansPanel";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowCounterClockwise, Bell, CheckCircle, CircleNotch, PaperPlaneTilt, Phone, Star, Warning, Wrench } from "@phosphor-icons/react";
import { ConditionPanel } from "./ConditionPanel";
import { MaintenancePanel } from "./MaintenancePanel";
import { ResidencyDialog } from "./ResidencyDialog";
import "./residency.css";
import { Stars } from "./PropertyReviews";
import { cedis } from "./format";
import { subscribeToHostelThread } from "./message-stream-client";

type Booking = {
  id: string; reference: string; propertyName: string; propertyAddress: string;
  roomLabel: string; spaceLabel: string; periodName: string;
  landlordName: string; landlordPhone: string; landlordEmail: string;
  price: number; utilitiesFee: number; totalAmount: number;
  status: string; paidAt: string; holdExpiresAt: string; note: string; createdAt: string;
  stayStatus: string; expectedArrivalOn: string; checkedInAt: string; checkedOutAt: string; periodStartsOn: string; periodEndsOn: string;
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
  EXPECTED: "Expected arrival", CHECKED_IN: "Checked in", CHECKED_OUT: "Checked out", NO_SHOW: "No-show", PENDING_PAYMENT: "Awaiting payment", EXPIRED: "Checkout expired",
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
  const [view, setView] = useState("current");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [historyTotal, setHistoryTotal] = useState(0);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [verification, setVerification] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [returnReference, setReturnReference] = useState("");
  const [serviceChoice, setServiceChoice] = useState<{ reference: string; pluginId: string } | null>(null);
  const sequence = useRef(0);
  const verifiedReturn = useRef("");
  const load = useCallback(async () => {
    const id = ++sequence.current;
    setLoading(true);
    try {
      const response = await fetch("/api/hostel/bookings?" + new URLSearchParams({ view, page: String(page) }), { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your residency could not be loaded.");
      if (id !== sequence.current) return;
      setError(""); setResidencies(data.residencies || []); setAnnouncements(data.announcements || []);
      setPagination(data.pagination || { page: 1, pages: 1, total: 0 }); setHistoryTotal(data.historyTotal || 0);
    } catch (cause) {
      if (id === sequence.current) { setError(cause instanceof Error ? cause.message : "Your residency could not be loaded."); setResidencies(current => current ?? []); }
    } finally { if (id === sequence.current) setLoading(false); }
  }, [view, page]);
  useEffect(() => { const requestSequence = sequence; queueMicrotask(() => void load()); return () => { requestSequence.current++; }; }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 45_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const verify = useCallback(async (reference: string) => {
    setVerifyBusy(true); setVerification("Confirming your payment…");
    try {
      const response = await fetch("/api/hostel/bookings/verify?" + new URLSearchParams({ reference }), { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Payment confirmation could not be checked. Try again shortly.");
      setVerification(data.booking?.status === "PAID" ? "Payment confirmed. Your bed is reserved and ready for arrival planning." : data.booking?.status === "PAYMENT_REVIEW" ? "Your payment needs an office review. Contact support with your booking reference." : "Payment is not confirmed yet. You can check again without starting another booking.");
      setSelected(reference); await load();
    } catch (cause) { setVerification(cause instanceof Error ? cause.message : "Could not confirm payment. Please check again."); }
    finally { setVerifyBusy(false); }
  }, [load]);
  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get("reference") || "";
    if (!reference || verifiedReturn.current === reference) return;
    verifiedReturn.current = reference;
    queueMicrotask(() => { setReturnReference(reference); void verify(reference); });
  }, [verify]);
  async function requestService() {
    if (!serviceChoice) return;
    const { reference, pluginId } = serviceChoice;
    setBusy(`service:${reference}:${pluginId}`); setError("");
    try {
      const response = await fetch("/api/hostel/services", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference, pluginId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That service could not be requested.");
      setServiceChoice(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That service could not be requested."); }
    finally { setBusy(""); }
  }
  const current = residencies?.find(item => item.booking.reference === selected) || residencies?.[0];
  const chosenService = residencies?.find(item => item.booking.reference === serviceChoice?.reference)?.plugins.find(plugin => plugin.pluginId === serviceChoice?.pluginId);
  return <div className="residency-dashboard">
    <div className="residency-view-switch" aria-label="Residency views">{[["current", "Current stays"], ["history", `History${historyTotal ? ` · ${historyTotal}` : ""}`]].map(([value, title]) => <button type="button" aria-pressed={view === value} key={value} onClick={() => { setView(value); setPage(1); setSelected(""); }}>{title}</button>)}</div>
    {verification && <div className="residency-success" role="status">{verification}{returnReference && <button type="button" disabled={verifyBusy} onClick={() => void verify(returnReference)}>{verifyBusy ? "Checking…" : "Check payment"}</button>}</div>}
    {error && <p className="residency-alert" role="alert">{error} <button type="button" disabled={loading} onClick={() => void load()}>Try again</button></p>}
    {loading && <p className="residency-loading" role="status">Updating your residency…</p>}
    {view === "current" && announcements.length > 0 && <details className="hostel-resident-notices residency-notices"><summary><Bell size={17} aria-hidden />Hostel notices · {announcements.length}</summary><ul>{announcements.map(notice => <li key={notice.id}><strong>{notice.title}</strong><span>{notice.body}</span><small>{notice.propertyName || "Your hostel"} · {when(notice.createdAt)}</small></li>)}</ul></details>}
    {residencies && residencies.length > 1 && <label className="residency-stay-selector">Choose a stay<select value={current?.booking.reference || ""} onChange={event => setSelected(event.target.value)}>{residencies.map(item => <option key={item.booking.id} value={item.booking.reference}>{item.booking.propertyName} · {item.booking.periodName} · {statusLabel[item.booking.status] || item.booking.status}</option>)}</select></label>}
    {current && <ResidencyCard key={current.booking.id} residency={current} busy={busy} onRequest={async (reference, pluginId) => { setError(""); setServiceChoice({ reference, pluginId }); }} onRefresh={load} onVerify={() => { setReturnReference(current.booking.reference); void verify(current.booking.reference); }} verifyBusy={verifyBusy} />}
    {!loading && !error && !current && <section className="residency-empty"><Warning size={26} aria-hidden /><h2>{view === "history" ? "No previous stays" : "No current hostel booking"}</h2><p>{view === "history" ? "Previous stays and cancelled bookings will be kept here." : "Your reserved bed and arrival details appear here after you start a booking."}</p>{view === "current" && <Link href="/hostel" className="hostel-card-link">Browse hostels</Link>}</section>}
    {pagination.pages > 1 && <nav className="residency-pagination" aria-label="Stay history pages"><span>Page {pagination.page} of {pagination.pages}</span><div><button type="button" disabled={loading || pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>Previous</button><button type="button" disabled={loading || pagination.page >= pagination.pages} onClick={() => setPage(pagination.page + 1)}>Next</button></div></nav>}
    <ResidencyDialog open={Boolean(serviceChoice)} title="Confirm service request" busy={Boolean(busy)} onClose={() => setServiceChoice(null)}>
      <div className="residency-form"><h3>{chosenService?.pluginName}</h3><p>{chosenService?.residentPrice ? `${cedis(chosenService.residentPrice)} per academic year. The hostel will review your request and arrange the service.` : "This service is included. The hostel will review your request."}</p>{error && <p className="residency-alert" role="alert">{error}</p>}<footer><button type="button" disabled={Boolean(busy)} onClick={() => setServiceChoice(null)}>Go back</button><button type="button" disabled={Boolean(busy)} onClick={() => void requestService()}>{busy ? "Sending…" : "Send request"}</button></footer></div>
    </ResidencyDialog>
  </div>;
}

function ResidencyCard({ residency, busy, onRequest, onRefresh, onVerify, verifyBusy }: {
  residency: Residency;
  busy: string;
  onRequest: (reference: string, pluginId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onVerify: () => void;
  verifyBusy: boolean;
}) {
  const { booking, plugins, services } = residency;
  const [activeTab, setActiveTab] = useState("overview");
  const [requestView, setRequestView] = useState("maintenance");
  useEffect(() => { if (new URLSearchParams(window.location.search).get("section") === "stay-plans") queueMicrotask(() => { setActiveTab("requests"); setRequestView("stay-plans"); }); }, []);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("section") === "conditions") queueMicrotask(() => { setActiveTab("requests"); setRequestView("conditions"); }); }, []);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("section") === "maintenance") queueMicrotask(() => setActiveTab("requests")); }, []);
  useEffect(() => { const section = new URLSearchParams(window.location.search).get("section"); if (section === "messages" || section === "payments") queueMicrotask(() => setActiveTab(section)); }, []);
  const [refundConfirm, setRefundConfirm] = useState(false);
  const stayClosed = ["CHECKED_OUT", "NO_SHOW", "CANCELLED"].includes(booking.stayStatus) || Boolean(booking.periodEndsOn && booking.periodEndsOn < new Date().toISOString().slice(0, 10));
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
      setRefundReason(""); setRefundConfirm(false);
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
  const threadOpen = activeTab === "messages" && thread !== null;
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
        {booking.status === "PAID" ? <CheckCircle size={13} aria-hidden /> : <Warning size={13} aria-hidden />}
        {statusLabel[booking.status] || booking.status}
      </span>
    </header>

    <nav className="residency-tabs" role="tablist" aria-label="Your stay" onKeyDown={event => {
      const tabs = ["overview", "requests", "messages", "payments"];
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 3 : (tabs.indexOf(activeTab) + (event.key === "ArrowRight" ? 1 : 3)) % 4;
      setActiveTab(tabs[next]); if (tabs[next] === "messages") void loadThread();
      (event.currentTarget.children[next] as HTMLButtonElement).focus();
    }}>{[["overview", "Overview"], ["requests", "Requests"], ["messages", "Messages"], ["payments", "Payments"]].map(([value, title]) => <button type="button" key={value} id={`${booking.id}-${value}-tab`} role="tab" aria-selected={activeTab === value} aria-controls={`${booking.id}-${value}`} tabIndex={activeTab === value ? 0 : -1} onClick={() => { setActiveTab(value); if (value === "messages") void loadThread(); }}>{title}</button>)}</nav>
    <div role="tabpanel" id={`${booking.id}-${activeTab}`} aria-labelledby={`${booking.id}-${activeTab}-tab`}>
    {activeTab === "overview" && <section className="residency-stay-summary"><h3>{booking.status === "PAID" ? statusLabel[booking.stayStatus] || "Arrival details" : statusLabel[booking.status]}</h3><dl className="residency-details"><div><dt>Academic year</dt><dd>{when(booking.periodStartsOn)} – {when(booking.periodEndsOn)}</dd></div><div><dt>Expected arrival</dt><dd>{when(booking.expectedArrivalOn) || "Arrange with your host"}</dd></div>{booking.checkedInAt && <div><dt>Checked in</dt><dd>{when(booking.checkedInAt)}</dd></div>}{booking.checkedOutAt && <div><dt>Departed</dt><dd>{when(booking.checkedOutAt)}</dd></div>}</dl>{booking.status === "PENDING_PAYMENT" && <p>Your bed is held until {booking.holdExpiresAt ? new Date(booking.holdExpiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "checkout expires"}. <button type="button" disabled={verifyBusy} onClick={onVerify}>{verifyBusy ? "Checking…" : "Check payment"}</button></p>}</section>}
    {activeTab === "payments" && <ul className="hostel-resident-facts">
      <li><span>Booking total</span><strong>{cedis(booking.totalAmount)}</strong></li>
      <li><span>Rent</span><strong>{cedis(booking.price)}</strong></li>
      {booking.utilitiesFee > 0 && <li><span>Utilities</span><strong>{cedis(booking.utilitiesFee)}</strong></li>}
      <li><span>Confirmed</span><strong>{when(booking.paidAt) || "Being reviewed"}</strong></li>
      <li><span>Reference</span><strong>{booking.reference}</strong></li>
    </ul>}

    {activeTab === "overview" && <section className="hostel-resident-host">
      <p>YOUR HOST</p>
      <strong>{booking.landlordName || "Hostel office"}</strong>
      <span>{booking.propertyAddress || "Address shared by your host"}</span>
      <div>
        {booking.landlordPhone && <a href={`tel:${booking.landlordPhone}`}><Phone size={13} aria-hidden />{booking.landlordPhone}</a>}
        {booking.landlordEmail && <a href={`mailto:${booking.landlordEmail}`}>{booking.landlordEmail}</a>}
      </div>
    </section>}

    {activeTab === "requests" && <nav className="residency-request-switch" aria-label="Resident care"><button type="button" aria-pressed={requestView === "stay-plans"} onClick={() => setRequestView("stay-plans")}>Stay plans</button><button type="button" aria-pressed={requestView === "maintenance"} onClick={() => setRequestView("maintenance")}>Maintenance</button><button type="button" aria-pressed={requestView === "conditions"} onClick={() => setRequestView("conditions")}>Room condition</button><button type="button" aria-pressed={requestView === "services"} onClick={() => setRequestView("services")}>Services</button></nav>}
    {activeTab === "requests" && requestView === "stay-plans" && <StayPlansPanel reference={booking.reference} />}
    {activeTab === "requests" && requestView === "conditions" && <ConditionPanel reference={booking.reference} />}
    {activeTab === "requests" && requestView === "maintenance" && <MaintenancePanel reference={booking.reference} />}
    {activeTab === "requests" && requestView === "services" && <section className="hostel-resident-services">
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
                : TERMINAL.includes(booking.status) || stayClosed || booking.status !== "PAID"
                  ? <span className="hostel-resident-muted">This stay is closed.</span>
                  : <button
                    type="button"
                    className="hostel-resident-service-button"
                    onClick={() => void onRequest(booking.reference, plugin.pluginId)}
                    disabled={busy === `service:${booking.reference}:${plugin.pluginId}`}
                  >
                    {busy === `service:${booking.reference}:${plugin.pluginId}` ? <CircleNotch size={13} className="console-spin" aria-hidden /> : null}
                    {last && !OPEN_SERVICE_STATUSES.includes(last.status) ? "Ask again" : "Ask for this"}
                  </button>}
              {last && !open && <small className="hostel-resident-muted">Last: {statusLabel[last.status] || last.status} · {when(last.createdAt)}</small>}
            </div>;
          })}
        </div>}
    </section>}

    {activeTab === "overview" && <details className="hostel-resident-review residency-review"><summary>Your hostel review</summary>
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
              {savingReview ? <CircleNotch size={14} className="console-spin" aria-hidden /> : <Star size={14} aria-hidden />} Post review
            </button>
            {reviewError && <span className="hostel-book-error">{reviewError}</span>}
          </form>
          : <span className="hostel-resident-muted">{TERMINAL.includes(booking.status) ? "This stay is closed, so there is no review to leave." : "A review opens once the bed is paid."}</span>}
    </details>}

    {activeTab === "payments" && <section className="hostel-resident-refund">
      <p><ArrowCounterClockwise size={13} aria-hidden /> CANCELLING THIS BED</p>
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
          ? <form onSubmit={event => { event.preventDefault(); setRefundConfirm(true); }}>
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
              {refundBusy ? <CircleNotch size={14} className="console-spin" aria-hidden /> : <ArrowCounterClockwise size={14} aria-hidden />} Ask to cancel and refund
            </button>
            <small className="hostel-resident-muted">The bed stays yours until an administrator approves, and the money moves after that.</small>
            {refundError && <span className="hostel-book-error">{refundError}</span>}
          </form>
          : <span className="hostel-resident-muted">
            {residency.refundQuote?.blockedReason || "There is nothing to refund on this booking."}
            {residency.refundQuote && residency.refundQuote.daysBeforeStart > 0 && ` The year starts in ${residency.refundQuote.daysBeforeStart} day${residency.refundQuote.daysBeforeStart === 1 ? "" : "s"}.`}
          </span>}
    </section>}

    {activeTab === "messages" && <section className="hostel-resident-thread">
      <h3>Messages with your host</h3>
      {thread === null && <p role="status">Loading messages…</p>}
      {threadError && <p className="residency-alert" role="alert">{threadError} <button type="button" onClick={() => void loadThread()}>Retry</button></p>}
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
              {sending ? <CircleNotch size={14} className="console-spin" aria-hidden /> : <PaperPlaneTilt size={14} aria-hidden />} Send
            </button>
          </form>}
        {threadError && <span className="hostel-book-error">{threadError}</span>}
      </div>}
    </section>}
    </div>
    <ResidencyDialog open={refundConfirm} title="Review cancellation request" busy={refundBusy} onClose={() => setRefundConfirm(false)}>
      <form className="residency-form" onSubmit={requestRefund}><h3>{booking.propertyName} · {booking.roomLabel}</h3><p>Estimated refund: <strong>{cedis(residency.refundQuote?.amount || 0)}</strong>. The administrator must approve your request. Your bed stays reserved until that decision.</p>{refundReason && <p>{refundReason}</p>}{refundError && <p className="residency-alert" role="alert">{refundError}</p>}<footer><button type="button" disabled={refundBusy} onClick={() => setRefundConfirm(false)}>Keep my booking</button><button type="submit" disabled={refundBusy}>{refundBusy ? "Sending…" : "Request cancellation"}</button></footer></form>
    </ResidencyDialog>
  </article>;
}
