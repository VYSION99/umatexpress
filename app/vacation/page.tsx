"use client";

import { checkoutFetch } from "@/lib/checkout-client";
import { usePaymentQuote } from "@/lib/payment-quote-client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatTime } from "@/lib/trips";
import { ArrowRight, Bus, CalendarDots, Check, Clock, MapPin, Robot, ShieldCheck, Sparkle, Users, X } from "@/components/ui/MaterialIcon";
import type { PublicNotice } from "@/lib/trip-notice";
import FlyerCarousel from "@/components/vacation/FlyerCarousel";
import "@/components/vacation/vacation.css";
import { readProfile, writeProfile } from "@/lib/passenger-profile";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import { SheetHandle } from "@/components/ui/SheetHandle";

type PublicTrip = {
  id: string;
  title: string;
  from: string;
  to: string;
  travelDate: string;
  time: string;
  arrival: string;
  price: number;
  capacity: number;
  coachType: string;
  tag: string;
  amenities: string[];
  notes: string;
  active?: boolean;
  organizerName?: string;
};

export default function Home() {
  const router = useRouter();
  const [selectedTrip, setSelectedTrip] = useState("1");
  const [visibleTrips, setVisibleTrips] = useState<PublicTrip[]>([]);
  const [notices, setNotices] = useState<PublicNotice[]>([]);
  // The route pickers are filled from the coaches on sale, never from a typed
  // list, so a destination appears the moment an organizer publishes it.
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [seatChoice, setSeatChoice] = useState<{ tripId: string; seat: number } | null>(null);
  const [passenger, setPassenger] = useState({ name: "", email: "", phone: "" });
  const { ready: accountReady, account } = useStudentAccount();
  // The account owns the receipt address, so a signed-in booking never uses a
  // typed-in email that could belong to someone else.
  const bookingEmail = account?.email || passenger.email;
  const [paymentError, setPaymentError] = useState("");
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paying, setPaying] = useState(false);
  const [unavailable, setUnavailable] = useState<number[]>([]);
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilityTripId, setAvailabilityTripId] = useState("");
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const availabilityRequest = useRef(0);
  const [passengerHelp, setPassengerHelp] = useState("");
  const [passengerHelpLoading, setPassengerHelpLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [aiError, setAiError] = useState("");
  const [dialogMode, setDialogMode] = useState<"" | "details" | "seat" | "review" | "how">("");
  const [detailsTrip, setDetailsTrip] = useState<PublicTrip | null>(null);
  const actionDialog = useRef<HTMLDialogElement>(null);

  const routeChoices = useMemo(() => ({
    from: [...new Set(visibleTrips.map((item) => item.from.trim()).filter(Boolean))].sort(),
    to: [...new Set(visibleTrips.map((item) => item.to.trim()).filter(Boolean))].sort(),
    dates: [...new Set(visibleTrips.map((item) => item.travelDate).filter(Boolean))].sort(),
  }), [visibleTrips]);
  const matchingTrips = useMemo(() => visibleTrips.filter((item) => (
    (!fromFilter || item.from === fromFilter)
    && (!toFilter || item.to === toFilter)
    && (!dateFilter || item.travelDate === dateFilter)
  )), [visibleTrips, fromFilter, toFilter, dateFilter]);
  const trip = useMemo(() => matchingTrips.find((item) => item.id === selectedTrip) ?? matchingTrips[0], [matchingTrips, selectedTrip]);
  const { quote: paymentQuote, error: quoteError } = usePaymentQuote(trip ? Math.round(Number(trip.price) * 100) : 0);
  const activeTripId = trip?.id || "";
  const selectedSeat = seatChoice?.tripId === activeTripId ? seatChoice.seat : null;
  const seatsReady = Boolean(trip && availabilityTripId === trip.id && !availabilityLoading);
  const hasFilters = Boolean(fromFilter || toFilter || dateFilter);
  /**
   * Coaches are grouped by who runs them. The platform's own trips share one
   * group, and a list from a single organizer keeps the flat grid it had before
   * organisers existed.
   */
  const tripGroups = useMemo(() => {
    const groups = new Map<string, PublicTrip[]>();
    for (const item of matchingTrips) {
      const key = item.organizerName?.trim() || "UMaTeXPRESS";
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return [...groups.entries()];
  }, [matchingTrips]);
  const routeFrom = fromFilter || trip?.from || "";
  const routeTo = toFilter || trip?.to || "";
  const headingDate = dateFilter || (matchingTrips.length > 0 && matchingTrips.every((item) => item.travelDate === matchingTrips[0].travelDate) ? matchingTrips[0].travelDate : "");
  const seatNumbers = useMemo(() => Array.from({ length: trip?.capacity || 50 }, (_, i) => i + 1), [trip?.capacity]);
  const loadTripDisplay = useCallback(async () => {
    try {
      const [response, displayResponse] = await Promise.all([
        fetch("/api/trips/schedule", { cache: "no-store" }),
        fetch("/api/trips/display", { cache: "no-store" }),
      ]);
      const data = await response.json();
      const displayData = await displayResponse.json();
      if (!response.ok) throw new Error(data.error || "Trips could not be loaded.");
      const activeLegacyIds = (displayResponse.ok ? displayData.activeTripIds : [1, 2]).map((id: number) => String(id));
      const trips: PublicTrip[] = (data.trips || []).filter((item: PublicTrip) => {
        if (item.active === false) return false;
        if (item.id === "1" || item.id === "2") return activeLegacyIds.includes(item.id);
        return true;
      });
      setVisibleTrips(trips);
      setSelectedTrip((current) => trips.some((item) => item.id === current) ? current : (trips[0]?.id || "1"));
      if (displayResponse.ok) setNotices(Array.isArray(displayData.notices) ? displayData.notices : []);
    } catch (error) {
      setAvailabilityError(error instanceof Error ? error.message : "Trips could not be loaded.");
    }
  }, []);
  const loadAvailability = useCallback(async (targetTrip: PublicTrip | undefined = trip) => {
    if (!targetTrip) return;
    const requestId = ++availabilityRequest.current;
    setAvailabilityLoading(true);
    setAvailabilityError("");
    try {
      const response = await fetch(`/api/trips/availability?tripId=${encodeURIComponent(targetTrip.id)}&travelDate=${targetTrip.travelDate}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Availability could not be loaded.");
      if (requestId !== availabilityRequest.current) return;
      const taken: number[] = Array.isArray(data.unavailableSeats) ? data.unavailableSeats : [];
      setUnavailable(taken);
      setAvailabilityTripId(targetTrip.id);
      setSeatChoice((current) => current?.tripId === targetTrip.id && (taken.includes(current.seat) || current.seat > targetTrip.capacity) ? null : current);
    } catch (error) {
      if (requestId !== availabilityRequest.current) return;
      setAvailabilityTripId("");
      setAvailabilityError(error instanceof Error ? error.message : "Live availability could not be loaded.");
    } finally {
      if (requestId === availabilityRequest.current) setAvailabilityLoading(false);
    }
  }, [trip]);
  useEffect(() => { queueMicrotask(loadTripDisplay); }, [loadTripDisplay]);
  // Repeat passengers should not retype the same three fields. Read after mount so
  // the server-rendered form never ships someone else's saved details.
  useEffect(() => {
    queueMicrotask(() => {
      const saved = readProfile();
      if (saved) setPassenger({ name: saved.name, email: saved.email, phone: saved.phone });
    });
  }, []);
  useEffect(() => { queueMicrotask(loadAvailability); }, [loadAvailability]);
  /**
   * The student describes the trip; the assistant chooses from the coaches
   * already on this page. When it finds one, it is selected here and the page
   * scrolls to the list, so the explanation and the result are in one place.
   */
  const searchWithAi = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    setAiBusy(true);
    setAiNote("");
    setAiError("");
    try {
      const response = await fetch("/api/trips/ai-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: prompt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Trip search is unavailable right now.");
      const reply = String(data.reply || "").trim();
      setAiNote(reply || "I could not match that to a coach. Try naming the destination or the date.");
      if (data.tripId && visibleTrips.some((item) => item.id === String(data.tripId))) {
        setFromFilter("");
        setToFilter("");
        setDateFilter("");
        setSelectedTrip(String(data.tripId));
        setPaymentError("");
        setPaymentMessage("");
        document.getElementById("trips")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "Trip search is unavailable right now.");
    } finally {
      setAiBusy(false);
    }
  };

  const fetchPassengerHelp = async () => {
    if (!trip) return;
    setPassengerHelpLoading(true);
    setPassengerHelp("");
    try {
      const response = await fetch("/api/passenger/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tripId: trip.id,
          travelDate: trip.travelDate,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI passenger help is unavailable right now.");
      setPassengerHelp(data.suggestion || "No help message was returned.");
    } catch (error) {
      setPassengerHelp(error instanceof Error ? error.message : "Passenger help is not available.");
    } finally {
      setPassengerHelpLoading(false);
    }
  };

  useEffect(() => {
    const dialog = actionDialog.current;
    if (!dialog) return;
    if (dialogMode) {
      if (!dialog.open) dialog.showModal();
      dialog.querySelector<HTMLElement>(".vacation-dialog-inner")?.scrollTo(0, 0);
      dialog.querySelector<HTMLElement>("#vacation-dialog-title")?.focus({ preventScroll: true });
    } else if (dialog.open) dialog.close();
  }, [dialogMode]);

  const travelDay = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const selectTrip = (item: PublicTrip) => {
    setSelectedTrip(item.id);
    if (item.id !== activeTripId) setSeatChoice(null);
    setPaymentError("");
    setPaymentMessage("");
    setDialogMode("seat");
    if (item.id === activeTripId) void loadAvailability(item);
  };
  const chooseSeat = (number: number) => {
    if (!trip || !seatsReady || unavailable.includes(number)) return;
    setSeatChoice({ tripId: trip.id, seat: number });
    setPaymentError("");
    setDialogMode("review");
  };
  const openReview = () => {
    if (selectedSeat === null || !seatsReady) { setDialogMode("seat"); return; }
    setPaymentError("");
    setDialogMode("review");
  };
  const confirmPayment = () => {
    setPaymentError("");
    if (!trip || selectedSeat === null || !seatsReady || unavailable.includes(selectedSeat)) {
      setPaymentError("This seat is no longer available. Choose another seat.");
      setDialogMode("seat");
      void loadAvailability();
      return;
    }
    if (!account) { router.push(`/account?next=${encodeURIComponent("/vacation#booking")}`); return; }
    if (!passenger.name.trim() || !passenger.phone.trim()) {
      setPaymentError("Enter your full name and Mobile Money number before continuing.");
      return;
    }
    void beginPayment();
  };
  const beginPayment = async () => {
    if (!trip || selectedSeat === null || paying || !account || !paymentQuote) return;
    setDialogMode("");
    setPaymentError("");
    setPaymentMessage("");
    setPaying(true);
    try {
      const response = await checkoutFetch("/api/payments/initialize", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...passenger, email: bookingEmail, seat: selectedSeat, tripId: trip.id, travelDate: trip.travelDate }) });
      const data = await response.json();
      if (!response.ok) { if (response.status === 409) { setSeatChoice(null); void loadAvailability(); } throw new Error(data.error || "Payment could not start."); }
      const paymentReference = String(data.reference || "");
      if (!paymentReference) throw new Error("Payment reference was not returned.");
      writeProfile({ name: passenger.name, email: bookingEmail, phone: passenger.phone });
      if (data.authorizationUrl) {
        setPaymentMessage("Redirecting to Paystack Checkout. Paystack will show the final amount including processing charge.");
        window.location.href = String(data.authorizationUrl);
        return;
      }
      setPaymentMessage("Opening Paystack checkout…");
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 3000 : 5000));
        const check = await fetch(`/api/payments/verify?reference=${encodeURIComponent(paymentReference)}`, { cache: "no-store" });
        const status = await check.json();
        if (!check.ok) throw new Error(status.error || "Payment verification failed.");
        if (status.status === "SUCCESSFUL") { router.push(`/payment/callback?reference=${encodeURIComponent(paymentReference)}`); return; }
        if (status.status === "FAILED") throw new Error("Payment failed or was declined. Please try again.");
        if (status.status === "PAID_REVIEW") throw new Error("Payment was received after the seat hold expired. Support will confirm a seat or arrange a refund.");
      }
      throw new Error("Payment is still pending. Please check your MoMo prompt and try verification again shortly.");
    } catch (error) {
      setPaymentMessage("");
      setPaymentError(error instanceof Error ? error.message : "Payment could not start.");
      setPaying(false);
    }
  };

  const tripCard = (item: PublicTrip) => (
    <article className={`trip-card ${activeTripId === item.id ? "selected" : ""}`} key={item.id}>
      <button type="button" className="trip-card-select" aria-pressed={activeTripId === item.id} aria-label={`Select ${item.from} to ${item.to} on ${travelDay(item.travelDate)}`} onClick={() => selectTrip(item)}>
        <div className="trip-top"><span className="pill">{item.tag || "Scheduled coach"}</span><span className="radio">{activeTripId === item.id && <Check size={14} />}</span></div>
        <div className="trip-date"><CalendarDots size={15} aria-hidden /> {travelDay(item.travelDate)}</div>
        <div className="times"><div><strong>{formatTime(item.time)}</strong><span>{item.from}</span></div><div className="duration"><span>Direct trip</span><i /><small>{item.coachType}</small></div><div><strong>{formatTime(item.arrival)}</strong><span>{item.to}</span></div></div>
        <div className="amenities">{item.amenities.slice(0, 3).map((amenity) => <span key={amenity}>{amenity}</span>)}</div>
        <div className="fare"><span><Clock size={15} aria-hidden /> {activeTripId === item.id && seatsReady ? `${Math.max(0, item.capacity - unavailable.length)} seats free` : `${item.capacity} seats total`}</span><div><small>per student</small><strong>GH₵ {item.price}</strong></div></div>
      </button>
      <div className="trip-card-actions"><button type="button" onClick={() => { setDetailsTrip(item); setDialogMode("details"); }}>View details</button><button type="button" onClick={() => selectTrip(item)}>{activeTripId === item.id ? "Choose a seat" : "Select trip"} <ArrowRight size={15} aria-hidden /></button></div>
    </article>
  );

  return (
    <main className="vacation">
      <header className="topbar">
        <Link className="brand logo-brand" href="/" aria-label="UMaTeXPRESS home"><img src="/logo-mark.png" alt="UMaTeXPRESS" /></Link>
        {/* Client navigation only. The management console lives on /admin and is
            deliberately not linked from the student-facing site. */}
        <nav aria-label="Main navigation"><Link href="/">Home</Link><a href="#trips">Trips</a><a href="#booking">Book a seat</a><Link href="/campus">campusRide</Link></nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkle size={14} aria-hidden /> VACATIONRIDE · STUDENT TRAVEL</div>
          <h1>Go home in comfort.<br /><em>Arrive with ease.</em></h1>
          <p>{routeFrom && routeTo ? `Direct VIP vacation transport from ${routeFrom} to ${routeTo}. Reserve your preferred seat and pay securely.` : "Direct VIP vacation transport for UMaT students. Reserve your preferred seat and pay securely."}</p>
          <div className="trust-row"><span><CalendarDots size={18} /> Published departures</span><span><Users size={18} /> Pick your seat</span><span><ShieldCheck size={18} /> Secure checkout</span></div>
          <div className="vacation-hero-actions"><a href="#trips">Explore trips <ArrowRight size={17} aria-hidden /></a><button type="button" onClick={() => setDialogMode("how")}>How booking works</button></div>
        </div>
        <div className="route-art" aria-label="UmateXPRESS 50-seat VIP coach">
          <div className="route-visual">
            <div className="coach-logo-badge"><img src="/logo-web.png" alt="UMaTeXPRESS" /></div>
            <div className="bus-photo-frame"><img src="/vip-coach.png" alt="Red VIP coach used as the UmateXPRESS bus reference" /><div className="coach-capacity"><strong>{trip?.capacity || 50}</strong><span>VIP seats</span></div></div>
          </div>
          {routeFrom && routeTo && <div className="art-card"><strong>{routeFrom} → {routeTo}</strong><span>Comfortable vacation travel</span></div>}
        </div>
      </section>

      <section className="search-card" aria-label="Search trips">
        <label><span>Leaving from</span><div><MapPin size={18} /><select aria-label="Leaving from" value={fromFilter} disabled={!routeChoices.from.length} onChange={(event) => setFromFilter(event.target.value)}>
          <option value="">{routeChoices.from.length ? "Any location" : "No trips yet"}</option>
          {routeChoices.from.map((place) => <option key={place} value={place}>{place}</option>)}
        </select></div></label>
        <button type="button" className="swap" aria-label="Swap locations" onClick={() => { setFromFilter(toFilter); setToFilter(fromFilter); }}>→</button>
        <label><span>Going to</span><div><MapPin size={18} /><select aria-label="Going to" value={toFilter} disabled={!routeChoices.to.length} onChange={(event) => setToFilter(event.target.value)}>
          <option value="">{routeChoices.to.length ? "Any destination" : "No trips yet"}</option>
          {routeChoices.to.map((place) => <option key={place} value={place}>{place}</option>)}
        </select></div></label>
        <label><span>Travel date</span><div><CalendarDots size={18} /><select aria-label="Travel date" value={dateFilter} disabled={!routeChoices.dates.length} onChange={(event) => setDateFilter(event.target.value)}>
          <option value="">Any date</option>
          {routeChoices.dates.map((day) => <option key={day} value={day}>{new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</option>)}
        </select></div></label>
        <a className="primary-button" href="#trips">Find trips <ArrowRight size={18} /></a>
      </section>

      <section className="search-ai" aria-label="Ask AI to find your trip">
        <form onSubmit={searchWithAi}>
          <Sparkle size={17} aria-hidden />
          <input
            aria-label="Describe the trip you want"
            placeholder={'Ask in your own words — “Accra next Friday”, “the early bus”'}
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
          />
          <button type="submit" disabled={aiBusy || !aiPrompt.trim()}>{aiBusy ? "Searching…" : "Find with AI"}</button>
        </form>
        {aiNote && <p className="search-ai-note" role="status">{aiNote}</p>}
        {aiError && <p className="search-ai-error" role="alert">{aiError}</p>}
      </section>

      <FlyerCarousel notices={notices} />

      <section className="content" id="trips">
        <div className="section-heading"><div><span className="step">01</span><h2>Choose your trip</h2><p>{headingDate ? `${new Date(`${headingDate}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · ` : ""}{routeFrom && routeTo ? `${routeFrom} to ${routeTo}` : "All routes"}</p></div><span className="results">{matchingTrips.length} {matchingTrips.length === 1 ? "coach" : "coaches"} available</span></div>
        {hasFilters && <div className="trip-filter-row">
          <span>{[fromFilter, toFilter, dateFilter ? new Date(`${dateFilter}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""].filter(Boolean).join(" · ")}</span>
          <button type="button" onClick={() => { setFromFilter(""); setToFilter(""); setDateFilter(""); }}>Show all coaches</button>
        </div>}
        {!matchingTrips.length && <div className="trip-empty">
          <strong>{visibleTrips.length ? "No coach matches that route yet" : "No coaches on sale yet"}</strong>
          <p>{visibleTrips.length ? "Try another destination or date; new coaches appear here as soon as organizers publish them." : "Coaches appear here as soon as organizers publish their trips."}</p>
          {hasFilters && <button type="button" onClick={() => { setFromFilter(""); setToFilter(""); setDateFilter(""); }}>Show all coaches</button>}
        </div>}
        {tripGroups.length > 1
          ? tripGroups.map(([organizerName, items]) => (
            <div className="trip-group" key={organizerName}>
              <h3 className="trip-group-name">{organizerName}</h3>
              <div className={`trip-grid ${items.length > 1 ? "trip-carousel" : ""}`}>
                {items.map((item) => tripCard(item))}
              </div>
            </div>
          ))
          : <div className={`trip-grid ${matchingTrips.length > 1 ? "trip-carousel" : ""}`}>
            {matchingTrips.map((item) => tripCard(item))}
          </div>}
      </section>

      {trip && <section className="booking-section" id="booking">
        <div className="section-heading light"><div><span className="step">02</span><h2>Your booking</h2><p>Select a trip to open the seat map, then review the journey before payment.</p></div></div>
        <div className="vacation-booking-overview">
          <div><span className="summary-label">SELECTED TRIP</span><h3>{trip.from} <ArrowRight size={23} aria-hidden /> {trip.to}</h3><p>{travelDay(trip.travelDate)} · {formatTime(trip.time)} · {trip.coachType}</p></div>
          <div className="vacation-overview-facts"><span><small>YOUR SEAT</small><strong>{selectedSeat === null ? "Choose a seat" : `Seat ${selectedSeat}`}</strong></span><span><small>TICKET PRICE</small><strong>GH₵ {trip.price}</strong></span></div>
          <div className="vacation-overview-actions"><button type="button" onClick={() => selectTrip(trip)}>{selectedSeat === null ? "Choose your seat" : "Change seat"} <ArrowRight size={17} aria-hidden /></button>{selectedSeat !== null && <button type="button" onClick={openReview}>Review booking <ArrowRight size={17} aria-hidden /></button>}</div>
          {availabilityError && <p className="payment-error" role="alert">{availabilityError}</p>}
          {paymentError && <p className="payment-error" role="alert">{paymentError}</p>}
          {paymentMessage && <p className="payment-pending" role="status">{paymentMessage}</p>}
          <div className="passenger-help-box"><button type="button" className="secondary-ai-button" disabled={passengerHelpLoading} onClick={fetchPassengerHelp}><Robot size={16} /> {passengerHelpLoading ? "Checking travel help..." : "Get travel help"}</button>{passengerHelp && <p>{passengerHelp}</p>}</div>
          <p className="vacation-overview-assurance"><ShieldCheck size={15} aria-hidden /> Secure UMaT student booking · Paystack checkout</p>
        </div>
      </section>}
      <dialog ref={actionDialog} className="vacation-dialog" aria-labelledby="vacation-dialog-title" onClose={() => setDialogMode("")} onCancel={() => setDialogMode("")} onClick={(event) => { if (event.target === event.currentTarget) setDialogMode(""); }}>
        <SheetHandle onDismiss={() => setDialogMode("")} />
        <div className="vacation-dialog-inner">
          <div className="vacation-dialog-head"><span>{dialogMode === "details" ? "TRIP DETAILS" : dialogMode === "seat" ? "SELECT YOUR SEAT" : dialogMode === "review" ? "BOOKING SUMMARY" : "BOOKING GUIDE"}</span><button type="button" aria-label="Close pop-up" onClick={() => setDialogMode("")}><X size={20} aria-hidden /></button></div>
          {dialogMode === "details" && detailsTrip && <>
            <h2 tabIndex={-1} id="vacation-dialog-title">{detailsTrip.from} to {detailsTrip.to}</h2>
            <p className="vacation-dialog-intro">{travelDay(detailsTrip.travelDate)} · {detailsTrip.organizerName || "UMaTeXPRESS"}</p>
            <div className="vacation-dialog-route"><div><small>DEPARTS</small><strong>{formatTime(detailsTrip.time)}</strong><span>{detailsTrip.from}</span></div><ArrowRight size={22} aria-hidden /><div><small>ARRIVES</small><strong>{formatTime(detailsTrip.arrival)}</strong><span>{detailsTrip.to}</span></div></div>
            <div className="vacation-dialog-facts"><span><Bus size={18} aria-hidden />{detailsTrip.coachType}</span><span><Users size={18} aria-hidden />{detailsTrip.capacity} seats</span><span><ShieldCheck size={18} aria-hidden />GH₵ {detailsTrip.price} per student</span></div>
            {detailsTrip.amenities.length > 0 && <div className="vacation-dialog-amenities">{detailsTrip.amenities.map((amenity) => <span key={amenity}>{amenity}</span>)}</div>}
            {detailsTrip.notes && <p className="vacation-dialog-note">{detailsTrip.notes}</p>}
            <div className="vacation-dialog-actions"><button type="button" className="vacation-dialog-primary" onClick={() => selectTrip(detailsTrip)}>Choose a seat <ArrowRight size={17} aria-hidden /></button><button type="button" onClick={() => setDialogMode("")}>Keep browsing</button></div>
          </>}
          {dialogMode === "seat" && trip && <>
            <h2 tabIndex={-1} id="vacation-dialog-title">Choose your seat</h2>
            <p className="vacation-dialog-intro">{trip.from} → {trip.to} · {travelDay(trip.travelDate)}. Tap an available seat to review your booking.</p>
            <div className="bus-shell vacation-seat-coach">
              <div className="driver"><span>Front of coach</span><span>◯</span></div>
              {availabilityLoading || availabilityTripId !== trip.id ? <p className="vacation-seat-status" role="status">Checking live availability…</p> : null}
              {availabilityError && <p className="vacation-seat-error" role="alert">{availabilityError}</p>}
              {seatsReady && unavailable.length >= trip.capacity && <p className="vacation-seat-error" role="status">This coach is full. Please choose another trip.</p>}
              <div className="seats" aria-label="Coach seats">{seatNumbers.map((number) => <button type="button" key={number} disabled={!seatsReady || unavailable.includes(number)} onClick={() => chooseSeat(number)} className={selectedSeat === number ? "chosen" : ""} aria-pressed={selectedSeat === number} aria-label={`Seat ${number}${!seatsReady ? ", checking availability" : unavailable.includes(number) ? ", taken" : selectedSeat === number ? ", selected" : ", available"}`}>{number}</button>)}</div>
              <div className="legend"><span><i className="available" /> Available</span><span><i className="chosen" /> Your seat</span><span><i className="taken" /> Taken</span></div>
            </div>
            <div className="vacation-dialog-actions">{selectedSeat !== null && seatsReady && <button type="button" className="vacation-dialog-primary" onClick={() => setDialogMode("review")}>Continue with seat {selectedSeat} <ArrowRight size={17} aria-hidden /></button>}<button type="button" onClick={() => setDialogMode("")}>Back to trips</button></div>
          </>}
          {dialogMode === "review" && trip && <>
            <h2 tabIndex={-1} id="vacation-dialog-title">Confirm your journey</h2><p className="vacation-dialog-intro">Review your route, seat and fare before opening secure checkout.</p>
            <dl className="vacation-review-list"><div><dt>Journey</dt><dd>{trip.from} → {trip.to}</dd></div><div><dt>Travel</dt><dd>{travelDay(trip.travelDate)} at {formatTime(trip.time)}</dd></div><div><dt>Coach and seat</dt><dd>{trip.coachType} · {selectedSeat === null ? "Seat not chosen" : `seat ${selectedSeat}`}</dd></div><div><dt>Receipt email</dt><dd>{account?.email || "Sign in to continue"}</dd></div><div><dt>Ticket price</dt><dd>GH₵ {trip.price}</dd></div><div><dt>Paystack processing ({paymentQuote?.feePercent ?? 1.95}%)</dt><dd>{paymentQuote ? `GH₵ ${(paymentQuote.feeAmount / 100).toFixed(2)}` : "Calculating…"}</dd></div><div className="vacation-review-total"><dt>Total to pay</dt><dd>{paymentQuote ? `GH₵ ${(paymentQuote.totalAmount / 100).toFixed(2)}` : "Calculating…"}</dd></div></dl>
            {accountReady && account && <div className="passenger-fields vacation-review-passenger"><label>Full name<input autoComplete="name" placeholder="Name on your ticket" value={passenger.name} onChange={(event) => setPassenger({ ...passenger, name: event.target.value })} /></label><label>Mobile Money number<input autoComplete="tel" type="tel" inputMode="tel" placeholder="e.g. 024 000 0000" value={passenger.phone} onChange={(event) => setPassenger({ ...passenger, phone: event.target.value })} /></label></div>}
            {(paymentError || quoteError) && <p className="vacation-dialog-error" role="alert">{paymentError || quoteError}</p>}
            <p className="vacation-dialog-note">Your seat is confirmed only after successful payment. The checkout provider may show a processing charge before you approve payment.</p>
            <div className="vacation-dialog-actions"><button type="button" className="vacation-dialog-primary" disabled={paying || !accountReady || !paymentQuote} onClick={confirmPayment}>{!account ? "Sign in to continue" : paying ? "Starting secure payment…" : "Continue to secure payment"} <ArrowRight size={17} aria-hidden /></button><button type="button" onClick={() => { setPaymentError(""); setDialogMode("seat"); }}>Change seat</button></div>
          </>}
          {dialogMode === "how" && <><h2 tabIndex={-1} id="vacation-dialog-title">A clear path home</h2><ol className="vacation-how-list"><li><strong>Choose a published trip.</strong><span>Open the details to check its route, date, coach and fare.</span></li><li><strong>Pick an available seat.</strong><span>Enter the name and phone number to use for your ticket and payment.</span></li><li><strong>Review and pay securely.</strong><span>Check your details before the payment provider opens. Your ticket follows confirmation.</span></li></ol><div className="vacation-dialog-actions"><button type="button" className="vacation-dialog-primary" onClick={() => { setDialogMode(""); window.setTimeout(() => document.getElementById("trips")?.scrollIntoView({ behavior: "smooth" }), 0); }}>Explore trips <ArrowRight size={17} aria-hidden /></button></div></>}
        </div>
      </dialog>
      <footer id="support"><div className="brand logo-brand"><img src="/logo-mark.png" alt="UMaTeXPRESS" /></div>{routeFrom && routeTo && <p>{routeFrom} → {routeTo}</p>}<span>Student vacation transport</span></footer>
    </main>
  );
}
