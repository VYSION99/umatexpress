"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BusFront, CircleDollarSign, Megaphone, RefreshCw, Save, TicketCheck, Users } from "lucide-react";
import { formatTime } from "@/lib/trips";
import { DEFAULT_FLYER_PROMO, type FlyerPromo, type TripDisplayMode, type TripSchedule } from "@/lib/trip-settings";

type Booking = { reference:string; passenger_name:string; email:string; phone:string; seat:string; trip_id:string; travel_date:string; amount:string; payment_status:string; booking_status:string; departure_time:string; created_at:string };

const displayOptions: Array<{ mode: TripDisplayMode; title: string; detail: string }> = [
  { mode: "MORNING", title: "Morning only", detail: "Show the morning coach" },
  { mode: "EVENING", title: "Afternoon / evening only", detail: "Show the later coach" },
  { mode: "BOTH", title: "Show both", detail: "Let students choose either coach" },
];
const defaultSchedule: TripSchedule = { morningDeparture:"06:30", morningArrival:"11:30", eveningDeparture:"13:00", eveningArrival:"18:00" };

export default function AdminPage() {
  const router=useRouter();
  const [bookings,setBookings]=useState<Booking[]>([]);
  const [displayMode,setDisplayMode]=useState<TripDisplayMode>("BOTH");
  const [schedule,setSchedule]=useState<TripSchedule>(defaultSchedule);
  const [flyerPromo,setFlyerPromo]=useState<FlyerPromo>(DEFAULT_FLYER_PROMO);
  const [error,setError]=useState("");
  const [saveMessage,setSaveMessage]=useState("");
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [authorized,setAuthorized]=useState(false);
  const [mustChangePassword,setMustChangePassword]=useState(false);

  const load=useCallback(async()=>{
    setLoading(true);
    try {
      const authResponse=await fetch("/api/admin/auth", { cache: "no-store" });
      if (!authResponse.ok) { router.replace("/admin/login"); return; }
      const authData=await authResponse.json();
      setMustChangePassword(Boolean(authData.mustChangePassword));
      setAuthorized(true);
      const [bookingsResponse, displayResponse] = await Promise.all([
        fetch("/api/admin/bookings", { cache: "no-store" }),
        fetch("/api/trips/display", { cache: "no-store" }),
      ]);
      const bookingData=await bookingsResponse.json();
      const displayData=await displayResponse.json();
      if(!bookingsResponse.ok) throw new Error(bookingData.error);
      if(!displayResponse.ok) throw new Error(displayData.error);
      setBookings(bookingData.bookings||[]);
      setDisplayMode(displayData.mode||"BOTH");
      setSchedule({ morningDeparture:displayData.morningDeparture, morningArrival:displayData.morningArrival, eveningDeparture:displayData.eveningDeparture, eveningArrival:displayData.eveningArrival });
      setFlyerPromo(displayData.flyerPromo||DEFAULT_FLYER_PROMO);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Admin data could not be loaded.");
    } finally { setLoading(false); }
  },[router]);

  useEffect(()=>{ queueMicrotask(load); },[load]);

  const saveSettings=async(payload:{mode?:TripDisplayMode;flyerPromo?:FlyerPromo}&Partial<TripSchedule>, message:string)=>{
    setSaving(true); setSaveMessage("");
    try {
      const response=await fetch("/api/trips/display",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Trip settings could not be saved.");
      setDisplayMode(data.mode);
      setSchedule({ morningDeparture:data.morningDeparture, morningArrival:data.morningArrival, eveningDeparture:data.eveningDeparture, eveningArrival:data.eveningArrival });
      setFlyerPromo(data.flyerPromo||flyerPromo);
      setSaveMessage(message); setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Trip settings could not be saved.");
    } finally { setSaving(false); }
  };

  const logout=async()=>{ await fetch("/api/admin/auth",{method:"DELETE"}); router.replace("/admin/login"); router.refresh(); };

  const updateTime=(field:keyof TripSchedule,value:string)=>setSchedule((current)=>({...current,[field]:value}));
  const updateFlyer=(field:keyof FlyerPromo,value:string|boolean|string[])=>setFlyerPromo((current)=>({...current,[field]:value}));
  const splitLines=(value:string)=>value.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
  const paid=bookings.filter((booking)=>["paid","successful"].includes(booking.payment_status.toLowerCase()));
  const confirmed=bookings.filter((booking)=>booking.booking_status==="CONFIRMED");
  const revenue=useMemo(()=>paid.reduce((sum,booking)=>sum+Number(booking.amount||0),0)/100,[paid]);

  if(!authorized) return <main className="admin-auth-check"><span className="spin">◌</span><p>Checking administrator access…</p></main>;

  return <main className="admin-page">
    <aside className="admin-sidebar"><Link className="brand" href="/"><span className="brand-mark"><BusFront size={20}/></span><span>Umate<span>XPRESS</span></span></Link><div><strong>ADMIN CONSOLE</strong><Link className="active" href="/admin">Overview</Link><Link href="/">Booking site</Link></div></aside>
    <section className="admin-main"><header><div><p>VACATION TRANSPORT</p><h1>Booking overview</h1></div><div className="admin-header-actions"><button onClick={load}><RefreshCw size={16} className={loading?"spin":""}/> Refresh</button><Link className="admin-action-link" href="/admin/change-password">Change password</Link><button onClick={logout}>Sign out</button></div></header>
      {mustChangePassword&&<div className="password-notice"><strong>Temporary password in use.</strong><span>Change it from the security page when your Turso database is connected.</span><Link href="/admin/change-password">Change password</Link></div>}
      <section className="trip-visibility-card">
        <div><p>BOOKING PAGE</p><h2>Trip schedule and visibility</h2><span>Choose the visible departures and adjust their times at any time.</span></div>
        <div className="trip-visibility-options">{displayOptions.map((option)=><button key={option.mode} className={displayMode===option.mode?"selected":""} disabled={saving} onClick={()=>saveSettings({mode:option.mode},"Booking page updated.")}><i /><strong>{option.title}</strong><span>{option.detail}</span></button>)}</div>
        <div className="schedule-editor">
          <fieldset><legend>Morning coach</legend><label>Departure<input type="time" value={schedule.morningDeparture} onChange={(event)=>updateTime("morningDeparture",event.target.value)}/></label><label>Arrival<input type="time" value={schedule.morningArrival} onChange={(event)=>updateTime("morningArrival",event.target.value)}/></label></fieldset>
          <fieldset><legend>Afternoon / evening coach</legend><label>Departure<input type="time" value={schedule.eveningDeparture} onChange={(event)=>updateTime("eveningDeparture",event.target.value)}/></label><label>Arrival<input type="time" value={schedule.eveningArrival} onChange={(event)=>updateTime("eveningArrival",event.target.value)}/></label></fieldset>
          <button className="save-schedule" disabled={saving} onClick={()=>saveSettings(schedule,"Schedule saved.")}><Save size={16}/>{saving?"Saving…":"Save times"}</button>
        </div>
        {saveMessage&&<small className="admin-save-message">{saveMessage}</small>}
      </section>
      <section className="trip-visibility-card flyer-editor">
        <div><p>PROMO FLYER</p><h2>Flyer content</h2><span>Show the flyer details on the booking page and update the public notice anytime.</span></div>
        <label className="promo-toggle"><input type="checkbox" checked={flyerPromo.enabled} onChange={(event)=>updateFlyer("enabled",event.target.checked)}/><span><Megaphone size={16}/> Show flyer promo on booking page</span></label>
        <div className="flyer-editor-grid">
          <label>Title<input value={flyerPromo.title} onChange={(event)=>updateFlyer("title",event.target.value)}/></label>
          <label>Route<input value={flyerPromo.route} onChange={(event)=>updateFlyer("route",event.target.value)}/></label>
          <label>Fare<input value={flyerPromo.fare} onChange={(event)=>updateFlyer("fare",event.target.value)}/></label>
          <label>Night bus<input value={flyerPromo.nightBus} onChange={(event)=>updateFlyer("nightBus",event.target.value)}/></label>
          <label>Day buses<textarea value={flyerPromo.dayBuses.join("\n")} onChange={(event)=>updateFlyer("dayBuses",splitLines(event.target.value))}/></label>
          <label>Drop-off points<textarea value={flyerPromo.dropOffPoints.join("\n")} onChange={(event)=>updateFlyer("dropOffPoints",splitLines(event.target.value))}/></label>
          <label>Features and amenities<textarea value={flyerPromo.amenities.join("\n")} onChange={(event)=>updateFlyer("amenities",splitLines(event.target.value))}/></label>
          <label>Organizer contacts<textarea value={flyerPromo.contacts.join("\n")} onChange={(event)=>updateFlyer("contacts",splitLines(event.target.value))}/></label>
        </div>
        <button className="save-schedule save-flyer" disabled={saving} onClick={()=>saveSettings({flyerPromo},"Flyer promo saved.")}><Save size={16}/>{saving?"Saving...":"Save flyer"}</button>
      </section>
      <div className="metric-grid"><article><Users/><span>Total bookings</span><strong>{bookings.length}</strong></article><article><TicketCheck/><span>Confirmed seats</span><strong>{confirmed.length}</strong></article><article><CircleDollarSign/><span>Payments received</span><strong>GH₵ {revenue.toFixed(2)}</strong></article></div>
      <section className="admin-table-card"><div><h2>Recent passengers</h2><span>UMaT Main Campus → Accra</span></div>
      {error?<div className="admin-empty"><strong>Admin services need attention</strong><p>{error}</p><small>Check the Turso credentials and ADMIN_EMAILS in your environment.</small></div>:
      <div className="table-wrap"><table><thead><tr><th>Passenger</th><th>Seat</th><th>Travel date</th><th>Departure</th><th>Reference</th><th>Payment</th><th>Amount</th></tr></thead><tbody>{bookings.map((booking)=><tr key={booking.reference}><td><strong>{booking.passenger_name}</strong><span>{booking.phone}</span></td><td>{booking.seat}</td><td>{booking.travel_date}</td><td><strong>{booking.departure_time?formatTime(booking.departure_time):(booking.trip_id==="2"?"1:00 PM":"6:30 AM")}</strong></td><td>{booking.reference}</td><td><span className={`payment-state ${booking.booking_status === "PAYMENT_RECEIVED_REVIEW" ? "PENDING" : booking.payment_status}`}>{booking.booking_status === "PAYMENT_RECEIVED_REVIEW" ? "PAID · REVIEW" : booking.payment_status}</span></td><td>GH₵ {(Number(booking.amount)/100).toFixed(2)}</td></tr>)}</tbody></table>{!loading&&!bookings.length&&<div className="admin-empty">No bookings yet.</div>}</div>}</section>
    </section>
  </main>;
}
