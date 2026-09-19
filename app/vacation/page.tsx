"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatTime, TRAVEL_DATE } from "@/lib/trips";
import { ArrowRight, Bot, BusFront, CalendarDays, Check, Clock3, MapPin, Megaphone, Phone, ShieldCheck, Sparkles, Users } from "lucide-react";
import { EMPTY_FLYER_PROMO, hasNoticeContent, type FlyerPromo } from "@/lib/trip-notice";
import { readProfile, writeProfile } from "@/lib/passenger-profile";
import { useStudentAccount } from "@/components/account/useStudentAccount";

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
  const [from] = useState("UMaT Main Campus");
  const [to] = useState("Accra");
  const [date] = useState(TRAVEL_DATE);
  const [selectedTrip, setSelectedTrip] = useState("1");
  const [visibleTrips, setVisibleTrips] = useState<PublicTrip[]>([]);
  const [flyerPromo, setFlyerPromo] = useState<FlyerPromo>(EMPTY_FLYER_PROMO);
  const [selectedSeat, setSelectedSeat] = useState(6);
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
  const [passengerHelp, setPassengerHelp] = useState("");
  const [passengerHelpLoading, setPassengerHelpLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [aiError, setAiError] = useState("");

  const trip = useMemo(() => visibleTrips.find((item) => item.id === selectedTrip) ?? visibleTrips[0], [selectedTrip, visibleTrips]);
  /**
   * Coaches are grouped by who runs them. The platform's own trips share one
   * group, and a list from a single organizer keeps the flat grid it had before
   * organisers existed.
   */
  const tripGroups = useMemo(() => {
    const groups = new Map<string, PublicTrip[]>();
    for (const item of visibleTrips) {
      const key = item.organizerName?.trim() || "UMaTeXPRESS";
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return [...groups.entries()];
  }, [visibleTrips]);
  const routeFrom = trip?.from || from;
  const routeTo = trip?.to || to;
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
      if (displayResponse.ok) setFlyerPromo(displayData.flyerPromo || EMPTY_FLYER_PROMO);
    } catch (error) {
      setAvailabilityError(error instanceof Error ? error.message : "Trips could not be loaded.");
    }
  }, []);
  const loadAvailability = useCallback(async () => {
    try {
      if (!trip) return;
      const response = await fetch(`/api/trips/availability?tripId=${encodeURIComponent(selectedTrip)}&travelDate=${trip.travelDate}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Availability could not be loaded.");
      setUnavailable(data.unavailableSeats || []);
      setAvailabilityError("");
      setSelectedSeat((current) => {
        if (!(data.unavailableSeats || []).includes(current)) return current;
        return seatNumbers.find((seat) => !(data.unavailableSeats || []).includes(seat)) ?? current;
      });
    } catch (error) {
      setAvailabilityError(error instanceof Error ? error.message : "Live availability could not be loaded.");
    }
  }, [selectedTrip, trip, seatNumbers]);
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

  const tripCard = (item: PublicTrip) => (
    <button className={`trip-card ${selectedTrip === item.id ? "selected" : ""}`} key={item.id} onClick={() => { setSelectedTrip(item.id); setPaymentError(""); setPaymentMessage(""); }}>
      <div className="trip-top"><span className="pill">{item.tag}</span><span className="radio">{selectedTrip === item.id && <Check size={14} />}</span></div>
      <div className="times"><div><strong>{formatTime(item.time)}</strong><span>{item.from}</span></div><div className="duration"><span>Direct trip</span><i /><small>{item.coachType}</small></div><div><strong>{formatTime(item.arrival)}</strong><span>{item.to}</span></div></div>
      <div className="amenities">{item.amenities.map((amenity) => <span key={amenity}>{amenity}</span>)}</div>
      <div className="fare"><span><Clock3 size={15} /> {selectedTrip === item.id ? item.capacity - unavailable.length : item.capacity} seats left</span><div><small>per student</small><strong>GH₵ {item.price}</strong></div></div>
    </button>
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
          <div className="eyebrow"><Sparkles size={14} /></div>
          <h1>Go home in comfort.<br /><em>Arrive with ease.</em></h1>
          <p>Direct VIP vacation transport from {routeFrom} to {routeTo}. Reserve your preferred seat and pay securely.</p>
          <div className="trust-row"><span><ShieldCheck size={18} /> Verified drivers</span><span><Users size={18} /> {trip?.capacity || 50}-seat coach</span><span><BusFront size={18} /> Premium VIP bus</span></div>
        </div>
        <div className="route-art" aria-label="UmateXPRESS 50-seat VIP coach">
          <div className="route-visual">
            <div className="coach-logo-badge"><img src="/logo-web.png" alt="UMaTeXPRESS" /></div>
            <div className="bus-photo-frame"><img src="/vip-coach.png" alt="Red VIP coach used as the UmateXPRESS bus reference" /><div className="coach-capacity"><strong>{trip?.capacity || 50}</strong><span>VIP seats</span></div></div>
          </div>
          <div className="art-card"><strong>{routeFrom} → {routeTo}</strong><span>Comfortable vacation travel</span></div>
        </div>
      </section>

      <section className="search-card" aria-label="Search trips">
        <label><span>Leaving from</span><div><MapPin size={18} /><strong>{routeFrom}</strong></div></label>
        <span className="swap">→</span>
        <label><span>Going to</span><div><MapPin size={18} /><strong>{routeTo}</strong></div></label>
        <label><span>Travel date</span><div><CalendarDays size={18} /><input type="date" value={trip?.travelDate || date} readOnly /></div></label>
        <a className="primary-button" href="#trips">Find trips <ArrowRight size={18} /></a>
      </section>

      <section className="search-ai" aria-label="Ask AI to find your trip">
        <form onSubmit={searchWithAi}>
          <Sparkles size={17} aria-hidden />
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

      {flyerPromo.enabled && hasNoticeContent(flyerPromo) && <section className="flyer-promo" aria-label="UMaT Express flyer information">
        <div className="flyer-main">
          <span><Megaphone size={15} /> Official trip notice</span>
          <h2>{flyerPromo.title}</h2>
          <p>{flyerPromo.route}</p>
          <strong>{flyerPromo.fare}</strong>
        </div>
        <div className="flyer-times">
          <article><span>Night bus</span><strong>{flyerPromo.nightBus}</strong></article>
          <article><span>Day bus</span>{flyerPromo.dayBuses.map((line) => <strong key={line}>{line}</strong>)}</article>
        </div>
        <div className="flyer-details">
          <div><span>Drop-off points</span><p>{flyerPromo.dropOffPoints.join(" · ")}</p></div>
          <div><span>Features and amenities</span><p>{flyerPromo.amenities.join(" · ")}</p></div>
        </div>
        <div className="flyer-contacts">
          {flyerPromo.contacts.map((contact) => {
            const phone = contact.match(/[+\d][\d\s-]{7,}/)?.[0]?.replace(/\s|-/g, "");
            return phone ? <a key={contact} href={`tel:${phone}`}><Phone size={14} /> {contact}</a> : <span key={contact}>{contact}</span>;
          })}
        </div>
      </section>}

      <section className="content" id="trips">
        <div className="section-heading"><div><span className="step">01</span><h2>Choose your trip</h2><p>{new Date(`${trip?.travelDate || date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · {routeFrom} to {routeTo}</p></div><span className="results">{visibleTrips.length} {visibleTrips.length === 1 ? "coach" : "coaches"} available</span></div>
        {tripGroups.length > 1
          ? tripGroups.map(([organizerName, items]) => (
            <div className="trip-group" key={organizerName}>
              <h3 className="trip-group-name">{organizerName}</h3>
              <div className={`trip-grid ${items.length > 1 ? "trip-carousel" : ""}`}>
                {items.map((item) => tripCard(item))}
              </div>
            </div>
          ))
          : <div className={`trip-grid ${visibleTrips.length > 1 ? "trip-carousel" : ""}`}>
            {visibleTrips.map((item) => tripCard(item))}
          </div>}
      </section>

      {trip && <section className="booking-section" id="booking">
        <div className="section-heading light"><div><span className="step">02</span><h2>Select your seat</h2><p>{trip.capacity}-seat coach · two seats left, central aisle, two seats right.</p></div></div>
        <div className="booking-grid">
          <div className="bus-shell">
            <div className="driver"><span>Front of coach</span><span>◯</span></div>
            <div className="seats" aria-label="Coach seats">{seatNumbers.map((number) => <button key={number} disabled={unavailable.includes(number)} onClick={() => { setSelectedSeat(number); setPaymentError(""); setPaymentMessage(""); }} className={selectedSeat === number ? "chosen" : ""} aria-label={`Seat ${number}`}>{number}</button>)}</div>
            <div className="legend"><span><i className="available" /> Available</span><span><i className="chosen" /> Your seat</span><span><i className="taken" /> Taken</span></div>
          </div>
          <aside className="summary">
            <span className="summary-label">Booking summary</span><h3>{routeFrom} <ArrowRight size={20} /> {routeTo}</h3>
            <div className="summary-row"><span>Travel date</span><strong>{new Date(`${trip.travelDate}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</strong></div>
            <div className="summary-row"><span>Departure</span><strong>{formatTime(trip.time)}</strong></div>
            <div className="summary-row"><span>Seat</span><strong className="seat-badge">{selectedSeat}</strong></div>
            <div className="divider" /><div className="summary-row"><span>Ticket price</span><strong>GH₵ {trip.price}.00</strong></div>
            <div className="total"><span>Total</span><strong>GH₵ {trip.price}.00</strong></div>
                        <div className="passenger-fields"><input aria-label="Passenger full name" placeholder="Full name" value={passenger.name} onChange={(e)=>setPassenger({...passenger,name:e.target.value})}/><input aria-label="Passenger email" type="email" placeholder="Student email" value={bookingEmail} readOnly={Boolean(account)} onChange={(e)=>setPassenger({...passenger,email:e.target.value})}/><input aria-label="Passenger phone" placeholder="Mobile Money number" value={passenger.phone} onChange={(e)=>setPassenger({...passenger,phone:e.target.value})}/></div>
            {availabilityError && <p className="payment-error">{availabilityError}</p>}
            {paymentError && <p className="payment-error">{paymentError}</p>}
            {paymentMessage && <p className="payment-pending">{paymentMessage}</p>}
            <div className="passenger-help-box">
              <button className="secondary-ai-button" disabled={passengerHelpLoading} onClick={fetchPassengerHelp}>
                <Bot size={16} /> {passengerHelpLoading ? "Checking travel help..." : "Get travel help"}
              </button>
              {passengerHelp && <p>{passengerHelp}</p>}
            </div>
            {accountReady && !account
              ? <Link className="confirm-button" href={`/account?next=${encodeURIComponent("/vacation#booking")}`}>Sign in to book this seat <ArrowRight size={18} /></Link>
              : <button className="confirm-button" disabled={paying} onClick={async () => {
              setPaymentError("");
              setPaymentMessage("");
              if(!account){window.location.assign(`/account?next=${encodeURIComponent("/vacation#booking")}`);return;}
              if(!passenger.name || !passenger.phone){setPaymentError("Enter your name and MTN MoMo number.");return;}
              setPaying(true);
              try {
                const response=await fetch("/api/payments/initialize",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({ ...passenger,email:bookingEmail,seat:selectedSeat,tripId:selectedTrip,travelDate:trip.travelDate })});
                const data=await response.json();
                if(!response.ok){ if(response.status===409) void loadAvailability(); throw new Error(data.error || "Payment could not start."); }
                const paymentReference=String(data.reference || "");
                if(!paymentReference) throw new Error("Payment reference was not returned.");
                writeProfile({ name: passenger.name, email: bookingEmail, phone: passenger.phone });
                if(data.authorizationUrl){
                  setPaymentMessage("Redirecting to Paystack Checkout. Paystack will show the final amount including processing charge.");
                  window.location.href=String(data.authorizationUrl);
                  return;
                }
                setPaymentMessage("Payment request sent. Approve the MTN MoMo prompt on your phone. Waiting for confirmation…");
                for(let attempt=0; attempt<24; attempt++){
                  await new Promise((resolve)=>setTimeout(resolve, attempt===0 ? 3000 : 5000));
                  const check=await fetch(`/api/payments/verify?reference=${encodeURIComponent(paymentReference)}`,{cache:"no-store"});
                  const status=await check.json();
                  if(!check.ok) throw new Error(status.error || "Payment verification failed.");
                  if(status.status==="SUCCESSFUL"){
                    window.location.href=`/payment/callback?reference=${encodeURIComponent(paymentReference)}`;
                    return;
                  }
                  if(status.status==="FAILED") throw new Error("Payment failed or was declined. Please try again.");
                  if(status.status==="PAID_REVIEW") throw new Error("Payment was received after the seat hold expired. Support will confirm a seat or arrange a refund.");
                }
                throw new Error("Payment is still pending. Please check your MoMo prompt and try verification again shortly.");
              } catch(error){
                setPaymentMessage("");
                setPaymentError(error instanceof Error?error.message:"Payment could not start.");
                setPaying(false);
              }
            }}>{paying ? "Starting secure payment..." : <>Pay GH₵{trip.price} securely <ArrowRight size={18} /></>}</button>}
            <p><ShieldCheck size={15} /> Secure UMaT student booking · Paystack or MTN MoMo</p>
          </aside>
        </div>
      </section>}
      <footer id="support"><div className="brand logo-brand"><img src="/logo-mark.png" alt="UMaTeXPRESS" /></div><p>{routeFrom} → {routeTo}</p><span>Student vacation transport</span></footer>
    </main>
  );
}
