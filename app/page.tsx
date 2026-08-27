"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, TRAVEL_DATE, trips } from "@/lib/trips";
import { ArrowRight, BusFront, CalendarDays, Check, Clock3, LayoutDashboard, MapPin, Megaphone, Phone, ShieldCheck, Sparkles, Users } from "lucide-react";
import { DEFAULT_FLYER_PROMO, type FlyerPromo } from "@/lib/trip-settings";

const seatNumbers = Array.from({ length: 50 }, (_, i) => i + 1);

export default function Home() {
  const [from] = useState("UMaT Main Campus");
  const [to] = useState("Accra");
  const [date] = useState(TRAVEL_DATE);
  const [selectedTrip, setSelectedTrip] = useState(1);
  const [activeTripIds, setActiveTripIds] = useState<number[]>([1, 2]);
  const [schedule, setSchedule] = useState({ morningDeparture: "06:30", morningArrival: "11:30", eveningDeparture: "13:00", eveningArrival: "18:00" });
  const [flyerPromo, setFlyerPromo] = useState<FlyerPromo>(DEFAULT_FLYER_PROMO);
  const [selectedSeat, setSelectedSeat] = useState(6);
  const [passenger, setPassenger] = useState({ name: "", email: "", phone: "" });
  const [paymentError, setPaymentError] = useState("");
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paying, setPaying] = useState(false);
  const [unavailable, setUnavailable] = useState<number[]>([]);
  const [availabilityError, setAvailabilityError] = useState("");
  const visibleTrips = useMemo(() => trips.filter((item) => activeTripIds.includes(item.id)).map((item) => ({
    ...item,
    time: formatTime(item.id === 2 ? schedule.eveningDeparture : schedule.morningDeparture),
    arrival: formatTime(item.id === 2 ? schedule.eveningArrival : schedule.morningArrival),
  })), [activeTripIds, schedule]);
  const trip = useMemo(() => visibleTrips.find((item) => item.id === selectedTrip) ?? visibleTrips[0] ?? trips[0], [selectedTrip, visibleTrips]);
  const loadTripDisplay = useCallback(async () => {
    try {
      const response = await fetch("/api/trips/display", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Trip settings could not be loaded.");
      const ids: number[] = data.activeTripIds || [1, 2];
      setActiveTripIds(ids);
      setSchedule({
        morningDeparture: data.morningDeparture, morningArrival: data.morningArrival,
        eveningDeparture: data.eveningDeparture, eveningArrival: data.eveningArrival,
      });
      setFlyerPromo(data.flyerPromo || DEFAULT_FLYER_PROMO);
      setSelectedTrip((current) => ids.includes(current) ? current : (ids[0] || 1));
    } catch (error) {
      setAvailabilityError(error instanceof Error ? error.message : "Trip settings could not be loaded.");
    }
  }, []);
  const loadAvailability = useCallback(async () => {
    try {
      const response = await fetch(`/api/trips/availability?tripId=${selectedTrip}&travelDate=${date}`, { cache: "no-store" });
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
  }, [selectedTrip, date]);
  useEffect(() => { queueMicrotask(loadTripDisplay); }, [loadTripDisplay]);
  useEffect(() => { queueMicrotask(loadAvailability); }, [loadAvailability]);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="UmateXPRESS home"><span className="brand-mark"><BusFront size={22} /></span><span>Umate<span>XPRESS</span></span></a>
        <nav aria-label="Main navigation"><a href="#trips">Trips</a><a href="#booking">Book a seat</a><a href="/admin">Admin</a></nav>
        <a className="outline-button admin-link" href="/admin"><LayoutDashboard size={16}/> Admin</a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={14} /> Vacation travel, made for students</div>
          <h1>Go home in comfort.<br /><em>Arrive with ease.</em></h1>
          <p>Direct VIP vacation transport from UMaT Main Campus to Accra. Reserve your preferred seat and pay securely.</p>
          <div className="trust-row"><span><ShieldCheck size={18} /> Verified drivers</span><span><Users size={18} /> 50-seat coach</span><span><BusFront size={18} /> Premium VIP bus</span></div>
        </div>
        <div className="route-art" aria-label="UmateXPRESS 50-seat VIP coach">
          <div className="bus-photo-frame"><img src="/vip-coach.png" alt="Red VIP coach used as the UmateXPRESS bus reference" /><div className="coach-capacity"><strong>50</strong><span>VIP seats</span></div></div>
          <div className="art-card"><strong>UMaT → Accra</strong><span>Comfortable vacation travel</span></div>
        </div>
      </section>

      <section className="search-card" aria-label="Search trips">
        <label><span>Leaving from</span><div><MapPin size={18} /><strong>{from}</strong></div></label>
        <span className="swap">→</span>
        <label><span>Going to</span><div><MapPin size={18} /><strong>{to}</strong></div></label>
        <label><span>Travel date</span><div><CalendarDays size={18} /><input type="date" value={date} min={TRAVEL_DATE} max={TRAVEL_DATE} readOnly /></div></label>
        <a className="primary-button" href="#trips">Find trips <ArrowRight size={18} /></a>
      </section>

      {flyerPromo.enabled && <section className="flyer-promo" aria-label="UMaT Express flyer information">
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
        <div className="section-heading"><div><span className="step">01</span><h2>Choose your trip</h2><p>{new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · UMaT to Accra</p></div><span className="results">{visibleTrips.length} {visibleTrips.length === 1 ? "coach" : "coaches"} available</span></div>
        <div className="trip-grid">
          {visibleTrips.map((item) => (
            <button className={`trip-card ${selectedTrip === item.id ? "selected" : ""}`} key={item.id} onClick={() => { setSelectedTrip(item.id); setPaymentError(""); setPaymentMessage(""); }}>
              <div className="trip-top"><span className="pill">{item.tag}</span><span className="radio">{selectedTrip === item.id && <Check size={14} />}</span></div>
              <div className="times"><div><strong>{item.time}</strong><span>{item.from}</span></div><div className="duration"><span>Direct trip</span><i /><small>VIP coach</small></div><div><strong>{item.arrival}</strong><span>{item.to}</span></div></div>
              <div className="amenities"><span>AC</span><span>Wi-Fi</span><span>USB power</span></div>
              <div className="fare"><span><Clock3 size={15} /> {50 - unavailable.length} seats left</span><div><small>per student</small><strong>GH₵ {item.price}</strong></div></div>
            </button>
          ))}
        </div>
      </section>

      <section className="booking-section" id="booking">
        <div className="section-heading light"><div><span className="step">02</span><h2>Select your seat</h2><p>50-seat coach · two seats left, central aisle, two seats right.</p></div></div>
        <div className="booking-grid">
          <div className="bus-shell">
            <div className="driver"><span>Front of coach</span><span>◯</span></div>
            <div className="seats" aria-label="Coach seats">{seatNumbers.map((number) => <button key={number} disabled={unavailable.includes(number)} onClick={() => { setSelectedSeat(number); setPaymentError(""); setPaymentMessage(""); }} className={selectedSeat === number ? "chosen" : ""} aria-label={`Seat ${number}`}>{number}</button>)}</div>
            <div className="legend"><span><i className="available" /> Available</span><span><i className="chosen" /> Your seat</span><span><i className="taken" /> Taken</span></div>
          </div>
          <aside className="summary">
            <span className="summary-label">Booking summary</span><h3>UMaT <ArrowRight size={20} /> Accra</h3>
            <div className="summary-row"><span>Travel date</span><strong>{new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</strong></div>
            <div className="summary-row"><span>Departure</span><strong>{trip.time}</strong></div>
            <div className="summary-row"><span>Seat</span><strong className="seat-badge">{selectedSeat}</strong></div>
            <div className="divider" /><div className="summary-row"><span>Ticket price</span><strong>GH₵ {trip.price}.00</strong></div>
            <div className="total"><span>Total</span><strong>GH₵ {trip.price}.00</strong></div>
            <div className="passenger-fields"><input aria-label="Passenger full name" placeholder="Full name" value={passenger.name} onChange={(e)=>setPassenger({...passenger,name:e.target.value})}/><input aria-label="Passenger email" type="email" placeholder="Student email" value={passenger.email} onChange={(e)=>setPassenger({...passenger,email:e.target.value})}/><input aria-label="Passenger phone" placeholder="Mobile Money number" value={passenger.phone} onChange={(e)=>setPassenger({...passenger,phone:e.target.value})}/></div>
            {availabilityError && <p className="payment-error">{availabilityError}</p>}
            {paymentError && <p className="payment-error">{paymentError}</p>}
            {paymentMessage && <p className="payment-pending">{paymentMessage}</p>}
            <button className="confirm-button" disabled={paying} onClick={async () => {
              setPaymentError("");
              setPaymentMessage("");
              if(!passenger.name || !passenger.email || !passenger.phone){setPaymentError("Enter your name, email and MTN MoMo number.");return;}
              setPaying(true);
              try {
                const response=await fetch("/api/payments/initialize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ ...passenger,seat:selectedSeat,tripId:selectedTrip,travelDate:date })});
                const data=await response.json();
                if(!response.ok){ if(response.status===409) void loadAvailability(); throw new Error(data.error || "Payment could not start."); }
                const paymentReference=String(data.reference || "");
                if(!paymentReference) throw new Error("Payment reference was not returned.");
                if(data.authorizationUrl){
                  setPaymentMessage("Redirecting to Paystack Checkout...");
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
            }}>{paying ? "Starting secure payment..." : <>Pay GH₵{trip.price} securely <ArrowRight size={18} /></>}</button>
            <p><ShieldCheck size={15} /> Secure UMaT student booking · Paystack or MTN MoMo</p>
          </aside>
        </div>
      </section>
      <footer id="support"><div className="brand"><span className="brand-mark"><BusFront size={20} /></span><span>Umate<span>XPRESS</span></span></div><p>UMaT Main Campus → Accra</p><span>Student vacation transport</span></footer>
    </main>
  );
}
