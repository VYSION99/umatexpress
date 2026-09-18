"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, CircleDollarSign, Copy, Edit3, Megaphone, RefreshCw, Save, Sparkles, TicketCheck, Trash2, Users } from "lucide-react";
import { formatTime, TRAVEL_DATE } from "@/lib/trips";
import { type FlyerPromo, type TripDisplayMode, type TripSchedule } from "@/lib/trip-settings";
import { EMPTY_FLYER_PROMO } from "@/lib/trip-notice";

type Booking = { reference:string; passenger_name:string; email:string; phone:string; seat:string; trip_id:string; travel_date:string; amount:string; payment_status:string; booking_status:string; departure_time:string; created_at:string };
type ScheduledTrip = { id:string; title:string; from:string; to:string; travelDate:string; time:string; arrival:string; price:number; capacity:number; coachType:string; tag:string; amenities:string[]; active:boolean; notes:string; displayOrder:number; createdAt:string };
type TripForm = { title:string; routeFrom:string; routeTo:string; travelDate:string; departureTime:string; arrivalTime:string; price:string; capacity:string; coachType:string; tag:string; amenities:string; notes:string; displayOrder:string; active:boolean };

const displayOptions: Array<{ mode: TripDisplayMode; title: string; detail: string }> = [
  { mode: "MORNING", title: "Morning only", detail: "Show the morning coach" },
  { mode: "EVENING", title: "Afternoon / evening only", detail: "Show the later coach" },
  { mode: "BOTH", title: "Show both", detail: "Let students choose either coach" },
];
const defaultSchedule: TripSchedule = { morningDeparture:"06:30", morningArrival:"11:30", eveningDeparture:"13:00", eveningArrival:"18:00" };
const defaultTripForm = (): TripForm => ({ title:"", routeFrom:"UMaT Main Campus", routeTo:"Accra", travelDate:TRAVEL_DATE, departureTime:"06:30", arrivalTime:"11:30", price:"180", capacity:"50", coachType:"VIP Coach", tag:"", amenities:"AC\nWi-Fi\nUSB power", notes:"", displayOrder:"0", active:true });

function splitLines(value:string) {
  return value.split(/\r?\n|,/).map((line)=>line.trim()).filter(Boolean);
}
function sortTrips(trips: ScheduledTrip[]) {
  return [...trips].sort((a,b)=>(a.displayOrder-b.displayOrder)||a.travelDate.localeCompare(b.travelDate)||a.time.localeCompare(b.time));
}
function tripToPayload(trip: ScheduledTrip, updates: Partial<ScheduledTrip> = {}) {
  const merged = { ...trip, ...updates };
  return { id:merged.id, title:merged.title, routeFrom:merged.from, routeTo:merged.to, travelDate:merged.travelDate, departureTime:merged.time, arrivalTime:merged.arrival, price:merged.price, capacity:merged.capacity, coachType:merged.coachType, tag:merged.tag, amenities:merged.amenities, notes:merged.notes, active:merged.active, displayOrder:merged.displayOrder };
}

const aiSectionLabels = ["Public title", "Passenger note", "Operations advice", "Risk check"] as const;

function cleanAiText(value: string) {
  return value
    .replace(/\*\*/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/\s+-\s+/g, "\n- ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatAiSectionBody(value: string) {
  return cleanAiText(value).split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function parseAiSuggestion(value: string) {
  const normalized = cleanAiText(value);
  const pattern = /(Public title|Passenger note|Operations advice|Risk check)\s*:\s*/gi;
  const matches = [...normalized.matchAll(pattern)];
  if (!matches.length) return [];

  return matches.map((match, index) => {
    const label = aiSectionLabels.find((item) => item.toLowerCase() === String(match[1]).toLowerCase()) || "Public title";
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index || normalized.length : normalized.length;
    return { label, lines: formatAiSectionBody(normalized.slice(start, end)) };
  }).filter((section) => section.lines.length);
}

function AiSuggestionCard({ suggestion }: { suggestion: string }) {
  const sections = parseAiSuggestion(suggestion);
  if (!sections.length) return <p>{cleanAiText(suggestion)}</p>;
  return <div className="ai-section-grid">
    {sections.map((section) => (
      <section key={section.label} className="ai-section-card">
        <h4>{section.label}</h4>
        {section.lines.length > 1
          ? <ul>{section.lines.map((line) => <li key={line}>{line.replace(/^-\s*/, "")}</li>)}</ul>
          : <p>{section.lines[0]}</p>}
      </section>
    ))}
  </div>;
}

export default function AdminPage() {
  const router=useRouter();
  const [bookings,setBookings]=useState<Booking[]>([]);
  const [displayMode,setDisplayMode]=useState<TripDisplayMode>("BOTH");
  const [schedule,setSchedule]=useState<TripSchedule>(defaultSchedule);
  const [flyerPromo,setFlyerPromo]=useState<FlyerPromo>(EMPTY_FLYER_PROMO);
  const [error,setError]=useState("");
  const [saveMessage,setSaveMessage]=useState("");
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [tripSaving,setTripSaving]=useState(false);
  const [authorized,setAuthorized]=useState(false);
  const [mustChangePassword,setMustChangePassword]=useState(false);
  const [scheduledTrips,setScheduledTrips]=useState<ScheduledTrip[]>([]);
  const [editingTripId,setEditingTripId]=useState("");
  const [aiSuggestion,setAiSuggestion]=useState("");
  const [aiLoading,setAiLoading]=useState(false);
  const [newTrip,setNewTrip]=useState<TripForm>(defaultTripForm);

  const load=useCallback(async()=>{
    setLoading(true);
    try {
      const authResponse=await fetch("/api/admin/auth", { cache:"no-store", credentials:"same-origin" });
      if (!authResponse.ok) { router.replace("/admin/login"); return; }
      const authData=await authResponse.json();
      if (authData.mustChangePassword) { router.replace("/admin/change-password"); return; }
      setMustChangePassword(Boolean(authData.mustChangePassword));
      setAuthorized(true);
      const [bookingsResponse, displayResponse, scheduledResponse] = await Promise.all([
        fetch("/api/admin/bookings", { cache:"no-store", credentials:"same-origin" }),
        fetch("/api/trips/display", { cache:"no-store", credentials:"same-origin" }),
        fetch("/api/trips/schedule?admin=1", { cache:"no-store", credentials:"same-origin" }),
      ]);
      const bookingData=await bookingsResponse.json();
      const displayData=await displayResponse.json();
      const scheduledData=await scheduledResponse.json();
      if(!bookingsResponse.ok) throw new Error(bookingData.error);
      if(!displayResponse.ok) throw new Error(displayData.error);
      if(!scheduledResponse.ok) throw new Error(scheduledData.error);
      setBookings(bookingData.bookings||[]);
      setDisplayMode(displayData.mode||"BOTH");
      setSchedule({ morningDeparture:displayData.morningDeparture, morningArrival:displayData.morningArrival, eveningDeparture:displayData.eveningDeparture, eveningArrival:displayData.eveningArrival });
      setFlyerPromo(displayData.flyerPromo||EMPTY_FLYER_PROMO);
      setScheduledTrips(sortTrips(scheduledData.trips||[]));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Admin data could not be loaded.");
    } finally { setLoading(false); }
  },[router]);

  useEffect(()=>{ queueMicrotask(load); },[load]);

  const patchTrip=async(trip:ScheduledTrip, updates:Partial<ScheduledTrip>, message="Trip updated.")=>{
    const response=await fetch("/api/trips/schedule", { method:"PATCH", headers:{"content-type":"application/json"}, credentials:"same-origin", body:JSON.stringify(tripToPayload(trip, updates)) });
    const data=await response.json();
    if (!response.ok) throw new Error(data.error || "The trip could not be updated.");
    setScheduledTrips((current)=>sortTrips(current.map((item)=>item.id===trip.id ? data.trip : item)));
    setSaveMessage(message);
    return data.trip as ScheduledTrip;
  };

  const saveSettings=async(payload:{mode?:TripDisplayMode;flyerPromo?:FlyerPromo}&Partial<TripSchedule>, message:string)=>{
    setSaving(true); setSaveMessage("");
    try {
      const response=await fetch("/api/trips/display",{method:"PATCH",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify(payload)});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Trip settings could not be saved.");
      setDisplayMode(data.mode);
      setSchedule({ morningDeparture:data.morningDeparture, morningArrival:data.morningArrival, eveningDeparture:data.eveningDeparture, eveningArrival:data.eveningArrival });
      setFlyerPromo(data.flyerPromo||flyerPromo);
      setSaveMessage(message); setError("");
      if (payload.morningDeparture || payload.morningArrival || payload.eveningDeparture || payload.eveningArrival) {
        const morning=scheduledTrips.find((trip)=>trip.id==="1");
        const evening=scheduledTrips.find((trip)=>trip.id==="2");
        if (morning) await patchTrip(morning,{time:data.morningDeparture, arrival:data.morningArrival},"Schedule saved.");
        if (evening) await patchTrip(evening,{time:data.eveningDeparture, arrival:data.eveningArrival},"Schedule saved.");
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Trip settings could not be saved.");
    } finally { setSaving(false); }
  };

  const logout=async()=>{ await fetch("/api/admin/auth",{method:"DELETE",credentials:"same-origin"}); window.location.assign("/admin/login"); };
  const resetTripForm=()=>{ setEditingTripId(""); setNewTrip(defaultTripForm()); setAiSuggestion(""); };
  const editTrip=(trip:ScheduledTrip, duplicate=false)=>{
    setEditingTripId(duplicate ? "" : trip.id);
    setNewTrip({ title:duplicate ? `${trip.title} copy` : trip.title, routeFrom:trip.from, routeTo:trip.to, travelDate:trip.travelDate, departureTime:trip.time, arrivalTime:trip.arrival, price:String(trip.price), capacity:String(trip.capacity), coachType:trip.coachType, tag:trip.tag, amenities:trip.amenities.join("\n"), notes:trip.notes, displayOrder:String(duplicate ? trip.displayOrder+1 : trip.displayOrder), active:duplicate ? false : trip.active });
    document.getElementById("trip-editor")?.scrollIntoView({ behavior:"smooth", block:"start" });
  };

  const createTrip=async()=>{
    const payload = { id:editingTripId||undefined, title:newTrip.title.trim(), routeFrom:newTrip.routeFrom.trim(), routeTo:newTrip.routeTo.trim(), travelDate:newTrip.travelDate, departureTime:newTrip.departureTime, arrivalTime:newTrip.arrivalTime, price:Number(newTrip.price), capacity:Number(newTrip.capacity), coachType:newTrip.coachType.trim(), tag:newTrip.tag.trim()||newTrip.title.trim(), amenities:splitLines(newTrip.amenities), notes:newTrip.notes.trim(), displayOrder:Number(newTrip.displayOrder), active:newTrip.active };
    if (!payload.title || !payload.routeFrom || !payload.routeTo || !payload.travelDate || !payload.departureTime || !payload.arrivalTime) { setError("Add a trip title, route, travel date, departure time, and arrival time."); return; }
    if (!Number.isFinite(payload.price) || payload.price <= 0) { setError("Set a valid fare in Ghana cedis."); return; }
    if (!Number.isFinite(payload.capacity) || payload.capacity <= 0) { setError("Seat capacity must be greater than zero."); return; }
    setTripSaving(true); setError("");
    try {
      const response=await fetch("/api/trips/schedule", { method:editingTripId?"PATCH":"POST", headers:{"content-type":"application/json"}, credentials:"same-origin", body:JSON.stringify(payload) });
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || "The trip could not be saved.");
      setScheduledTrips((current)=>sortTrips(editingTripId ? current.map((trip)=>trip.id===editingTripId ? data.trip : trip) : [data.trip, ...current]));
      setSaveMessage(editingTripId ? "Trip updated successfully." : "Trip scheduled successfully.");
      resetTripForm();
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "The trip could not be saved.");
    } finally { setTripSaving(false); }
  };

  const toggleTrip=async(trip:ScheduledTrip)=>{ try { await patchTrip(trip,{active:!trip.active},trip.active ? "Trip hidden from passengers." : "Trip visible to passengers."); } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : "Trip status could not be updated."); } };
  const archiveTrip=async(trip:ScheduledTrip)=>{
    if (!confirm(`Archive ${trip.title}? This hides it from passengers and removes it from this admin list.`)) return;
    try {
      const response=await fetch("/api/trips/schedule",{method:"DELETE",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({id:trip.id})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error || "Trip could not be archived.");
      setScheduledTrips((current)=>current.filter((item)=>item.id!==trip.id));
      setSaveMessage("Trip archived.");
    } catch (archiveError) { setError(archiveError instanceof Error ? archiveError.message : "Trip could not be archived."); }
  };
  const moveTrip=async(trip:ScheduledTrip, direction:-1|1)=>{
    const index=scheduledTrips.findIndex((item)=>item.id===trip.id);
    const swap=scheduledTrips[index+direction];
    if(!swap) return;
    try {
      await patchTrip(trip,{displayOrder:swap.displayOrder},"Trip order updated.");
      await patchTrip(swap,{displayOrder:trip.displayOrder},"Trip order updated.");
    } catch (moveError) { setError(moveError instanceof Error ? moveError.message : "Trip order could not be updated."); }
  };

  const askAi = async (mode: "suggestion" | "passenger-help") => {
    const prompt = mode === "suggestion"
      ? `Create a helpful trip suggestion for ${newTrip.title || "this vacationRide trip"} from ${newTrip.routeFrom || "UMaT Main Campus"} to ${newTrip.routeTo || "Accra"}. Include a short marketing note, timing advice, fare positioning, and customer reassurance.`
      : `Help a passenger who wants to travel from ${newTrip.routeFrom || "UMaT Main Campus"} to ${newTrip.routeTo || "Accra"}. Give a brief answer about the travel date, departure time, arrival expectations, and what to do before boarding.`;
    setAiLoading(true); setAiSuggestion("");
    try {
      const response = await fetch("/api/admin/ai", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify({ mode, context:`Module: vacationRide\nTrip title: ${newTrip.title || "New package"}\nFrom: ${newTrip.routeFrom || "UMaT Main Campus"}\nTo: ${newTrip.routeTo || "Accra"}\nTravel date: ${newTrip.travelDate || "Not set"}\nDeparture: ${newTrip.departureTime || "06:30"}\nArrival: ${newTrip.arrivalTime || "11:30"}\nFare: ${newTrip.price || "180"}\nCoach: ${newTrip.coachType || "VIP Coach"}\nAmenities: ${splitLines(newTrip.amenities).join(", ")}`, prompt }) });
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || "AI suggestion could not be generated.");
      setAiSuggestion(data.suggestion || "No suggestion returned.");
      if (data.error) setError(`AI detail: ${data.error}`);
    } catch (aiError) {
      setError(aiError instanceof Error ? aiError.message : "AI suggestion could not be generated.");
    } finally { setAiLoading(false); }
  };

  const cancelBooking=async(reference:string)=>{
    if (!confirm("Cancel this booking and release the seat?")) return;
    try {
      const response=await fetch("/api/admin/bookings", { method:"DELETE", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify({ reference, mode:"cancel" }) });
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || "Booking could not be cancelled.");
      setBookings((current)=>current.map((booking)=>booking.reference===reference ? {...booking,payment_status:"CANCELLED",booking_status:"CANCELLED"} : booking));
      setError("");
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Booking could not be cancelled.");
    }
  };
  const deleteCancelledBooking=async(reference:string)=>{
    if (!confirm("Permanently delete this cancelled booking? A log will be kept.")) return;
    try {
      const response=await fetch("/api/admin/bookings", { method:"DELETE", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify({ reference, mode:"delete" }) });
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || "Cancelled booking could not be deleted.");
      setBookings((current)=>current.filter((booking)=>booking.reference!==reference));
      setSaveMessage("Cancelled booking deleted and logged.");
      setError("");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Cancelled booking could not be deleted.");
    }
  };

  const updateTime=(field:keyof TripSchedule,value:string)=>setSchedule((current)=>({...current,[field]:value}));
  const updateFlyer=(field:keyof FlyerPromo,value:string|boolean|string[])=>setFlyerPromo((current)=>({...current,[field]:value}));
  const paid=bookings.filter((booking)=>["paid","successful"].includes(booking.payment_status.toLowerCase()));
  const confirmed=bookings.filter((booking)=>booking.booking_status==="CONFIRMED");
  const revenue=useMemo(()=>paid.reduce((sum,booking)=>sum+Number(booking.amount||0),0)/100,[paid]);

  if(!authorized) return <main className="admin-auth-check"><span className="spin">◌</span><p>Checking administrator access…</p></main>;

  return <main className="admin-page">
    <aside className="admin-sidebar">
      <Link href="/admin" className="admin-logo" aria-label="UMaTeXPRESS admin home"><img src="/logo.svg" alt="UMaTeXPRESS Student Transport" /></Link>
      <nav className="admin-nav"><strong>ADMIN CONSOLE</strong><Link href="/admin">Super admin home</Link><Link className="active" href="/admin/vacation">vacationRide</Link><Link href="/admin/campus">campusRide</Link><Link href="/">Client home</Link><Link href="/vacation">Booking site</Link></nav>
    </aside>
    <section className="admin-main">
      <header><div><p>VACATIONRIDE TRANSPORT</p><h1>Booking overview</h1></div><div className="admin-header-actions"><button onClick={load}><RefreshCw size={16} className={loading?"spin":""}/> Refresh</button><Link className="admin-action-link" href="/admin/change-password">Change password</Link><button onClick={logout}>Sign out</button></div></header>
      {mustChangePassword&&<div className="password-notice"><strong>Temporary password in use.</strong><span>Change it from the security page when your Turso database is connected.</span><Link href="/admin/change-password">Change password</Link></div>}
      <section className="trip-scheduler-card" id="trip-editor">
        <div className="trip-scheduler-header"><div><p>TRIP SCHEDULER</p><h2>{editingTripId ? "Edit vacationRide trip" : "Schedule a vacationRide trip"}</h2></div><span>Create multiple departures, routes, dates, fares, and coach setups.</span></div>
        <div className="trip-scheduler-grid">
          <label><span>Trip title</span><input value={newTrip.title} onChange={(event)=>setNewTrip((current)=>({...current,title:event.target.value}))} placeholder="UMaT VIP Express" /></label>
          <label><span>Coach type</span><input value={newTrip.coachType} onChange={(event)=>setNewTrip((current)=>({...current,coachType:event.target.value}))} placeholder="VIP Coach" /></label>
          <label><span>From</span><input value={newTrip.routeFrom} onChange={(event)=>setNewTrip((current)=>({...current,routeFrom:event.target.value}))} placeholder="UMaT Main Campus" /></label>
          <label><span>To</span><input value={newTrip.routeTo} onChange={(event)=>setNewTrip((current)=>({...current,routeTo:event.target.value}))} placeholder="Accra" /></label>
          <label><span>Travel date</span><input type="date" value={newTrip.travelDate} onChange={(event)=>setNewTrip((current)=>({...current,travelDate:event.target.value}))} /></label>
          <label><span>Departure</span><input type="time" value={newTrip.departureTime} onChange={(event)=>setNewTrip((current)=>({...current,departureTime:event.target.value}))} /></label>
          <label><span>Arrival</span><input type="time" value={newTrip.arrivalTime} onChange={(event)=>setNewTrip((current)=>({...current,arrivalTime:event.target.value}))} /></label>
          <label><span>Fare (GHS)</span><input type="number" min="1" step="1" value={newTrip.price} onChange={(event)=>setNewTrip((current)=>({...current,price:event.target.value}))} /></label>
          <label><span>Seat capacity</span><input type="number" min="1" step="1" value={newTrip.capacity} onChange={(event)=>setNewTrip((current)=>({...current,capacity:event.target.value}))} /></label>
          <label><span>Display order</span><input type="number" step="1" value={newTrip.displayOrder} onChange={(event)=>setNewTrip((current)=>({...current,displayOrder:event.target.value}))} /></label>
          <label><span>Public tag</span><input value={newTrip.tag} onChange={(event)=>setNewTrip((current)=>({...current,tag:event.target.value}))} placeholder="Morning Express" /></label>
          <label className="trip-notes-field"><span>Amenities</span><textarea value={newTrip.amenities} onChange={(event)=>setNewTrip((current)=>({...current,amenities:event.target.value}))} placeholder={"AC\nWi-Fi\nUSB power"} /></label>
          <label className="trip-notes-field"><span>Notes</span><textarea value={newTrip.notes} onChange={(event)=>setNewTrip((current)=>({...current,notes:event.target.value}))} placeholder="Optional announcement or trip notes" /></label>
          <label className="trip-toggle-row"><span>Trip status</span><div className="trip-toggle-box"><input type="checkbox" checked={newTrip.active} onChange={(event)=>setNewTrip((current)=>({...current,active:event.target.checked}))} /><strong>{newTrip.active ? "Active" : "Inactive"}</strong></div></label>
        </div>
        <div className="trip-scheduler-actions">
          <button className="save-schedule" disabled={tripSaving} onClick={createTrip}><Save size={16}/>{tripSaving ? "Saving..." : editingTripId ? "Update trip" : "Create trip"}</button>
          {editingTripId && <button className="admin-action-link" disabled={tripSaving} onClick={resetTripForm}>Cancel edit</button>}
          <button className="ai-helper-button" disabled={aiLoading} onClick={() => askAi("suggestion")}><Sparkles size={16}/>{aiLoading ? "Thinking..." : "AI suggestion"}</button>
        </div>
        {saveMessage && <small className="admin-save-message">{saveMessage}</small>}
        {aiSuggestion && <div className="ai-response-box"><div className="ai-response-header"><Bot size={16}/> AI assistant</div><AiSuggestionCard suggestion={aiSuggestion}/></div>}
        <div className="scheduled-trip-list">
          <h3>Scheduled trips</h3>
          {scheduledTrips.length ? scheduledTrips.map((trip,index) => (
            <article key={trip.id} className="scheduled-trip-item">
              <div><span className="scheduled-trip-pill">{trip.active ? "Active" : "Hidden"}</span><strong>{trip.title}</strong></div>
              <p>{trip.from} → {trip.to} · {new Date(`${trip.travelDate}T00:00:00`).toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })}</p>
              <ul><li>{formatTime(trip.time)} - {formatTime(trip.arrival)}</li><li>{trip.coachType}</li><li>GH₵ {trip.price}</li><li>{trip.capacity} seats</li><li>Order {trip.displayOrder}</li></ul>
              <small>{trip.amenities.join(" · ")}{trip.notes ? ` · ${trip.notes}` : ""}</small>
              <div className="scheduled-trip-actions">
                <button onClick={()=>editTrip(trip)}><Edit3 size={14}/> Edit</button>
                <button onClick={()=>editTrip(trip,true)}><Copy size={14}/> Duplicate</button>
                <button onClick={()=>toggleTrip(trip)}>{trip.active ? "Hide" : "Show"}</button>
                <button disabled={index===0} onClick={()=>moveTrip(trip,-1)}>Move up</button>
                <button disabled={index===scheduledTrips.length-1} onClick={()=>moveTrip(trip,1)}>Move down</button>
                <button className="danger" onClick={()=>archiveTrip(trip)}><Trash2 size={14}/> Archive</button>
              </div>
            </article>
          )) : <div className="admin-empty">No custom trips scheduled yet.</div>}
        </div>
      </section>
      <section className="trip-visibility-card">
        <div><p>BOOKING PAGE</p><h2>Legacy display shortcuts</h2><span>These controls still manage the seeded morning/evening trips. Use the scheduler above for all new dynamic trips.</span></div>
        <div className="trip-visibility-options">{displayOptions.map((option)=><button key={option.mode} className={displayMode===option.mode?"selected":""} disabled={saving} onClick={()=>saveSettings({mode:option.mode},"Booking page updated.")}><i /><strong>{option.title}</strong><span>{option.detail}</span></button>)}</div>
        <div className="schedule-editor">
          <fieldset><legend>Morning coach</legend><label>Departure<input type="time" value={schedule.morningDeparture} onChange={(event)=>updateTime("morningDeparture",event.target.value)}/></label><label>Arrival<input type="time" value={schedule.morningArrival} onChange={(event)=>updateTime("morningArrival",event.target.value)}/></label></fieldset>
          <fieldset><legend>Afternoon / evening coach</legend><label>Departure<input type="time" value={schedule.eveningDeparture} onChange={(event)=>updateTime("eveningDeparture",event.target.value)}/></label><label>Arrival<input type="time" value={schedule.eveningArrival} onChange={(event)=>updateTime("eveningArrival",event.target.value)}/></label></fieldset>
          <button className="save-schedule" disabled={saving} onClick={()=>saveSettings(schedule,"Schedule saved.")}><Save size={16}/>{saving?"Saving…":"Save times"}</button>
        </div>
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
      <section className="admin-table-card"><div><h2>Recent passengers</h2><span>Latest bookings across vacationRide trips</span></div>
      {error?<div className="admin-empty"><strong>Admin services need attention</strong><p>{error}</p><small>Check Turso, Paystack, AI, and admin environment values.</small></div>:
      <div className="table-wrap"><table><thead><tr><th>Passenger</th><th>Seat</th><th>Travel date</th><th>Departure</th><th>Reference</th><th>Payment</th><th>Amount</th><th>Action</th></tr></thead><tbody>{bookings.map((booking)=>{ const isCancelled=booking.booking_status==="CANCELLED"||booking.payment_status==="CANCELLED"; return <tr key={booking.reference}><td><strong>{booking.passenger_name}</strong><span>{booking.phone}</span></td><td>{booking.seat}</td><td>{booking.travel_date}</td><td><strong>{booking.departure_time?formatTime(booking.departure_time):(booking.trip_id==="2"?"1:00 PM":"6:30 AM")}</strong></td><td>{booking.reference}</td><td><span className={`payment-state ${booking.booking_status === "PAYMENT_RECEIVED_REVIEW" ? "PENDING" : booking.payment_status}`}>{booking.booking_status === "PAYMENT_RECEIVED_REVIEW" ? "PAID · REVIEW" : booking.payment_status}</span></td><td>GH₵ {(Number(booking.amount)/100).toFixed(2)}</td><td>{isCancelled?<button className="admin-cancel-button delete" onClick={() => deleteCancelledBooking(booking.reference)}>Delete</button>:<button className="admin-cancel-button" onClick={() => cancelBooking(booking.reference)}>Cancel</button>}</td></tr>; })}</tbody></table>{!loading&&!bookings.length&&<div className="admin-empty">No bookings yet.</div>}</div>}</section>
    </section>
  </main>;
}
