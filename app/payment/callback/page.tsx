"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatTime } from "@/lib/trips";
import { rememberTicket } from "@/lib/passenger-profile";
import { BusFront, CheckCircle2, Download, ImageDown, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";

 type Ticket = { reference:string; passenger_name:string; seat:string; trip_id:string; travel_date:string; departure_time:string; arrival_time?:string; amount:string; route_from?:string; route_to?:string; coach_type?:string; trip_title?:string };

export default function PaymentCallback() {
  const [state, setState] = useState<"checking"|"success"|"failed"|"review">("checking");
  const [ticket,setTicket]=useState<Ticket|null>(null);
  const [imageSaving,setImageSaving]=useState(false);
  const ticketRef=useRef<HTMLElement|null>(null);
  useEffect(() => {
    const reference=new URLSearchParams(window.location.search).get("reference");
    if (!reference) { queueMicrotask(() => setState("failed")); return; }
    let cancelled=false;
    const verify=async()=>{
      for(let attempt=0;attempt<12&&!cancelled;attempt++){
        try{
          const r=await fetch(`/api/payments/verify?reference=${encodeURIComponent(reference)}`,{cache:"no-store"});
          const data=await r.json();
          if(!r.ok) throw new Error();
          if(data.status==="SUCCESSFUL"&&data.ticket){setTicket(data.ticket);setState("success");rememberTicket({reference,kind:"vacation"});return;}
          if(data.status==="PAID_REVIEW"){setState("review");return;}
          if(data.status==="FAILED"){setState("failed");return;}
          await new Promise((resolve)=>setTimeout(resolve,4000));
        }catch{setState("failed");return;}
      }
      if(!cancelled)setState("failed");
    };
    void verify();
    return()=>{cancelled=true;};
  }, []);
  const arrival=ticket?.arrival_time ? formatTime(ticket.arrival_time) : "";
  const date=ticket?new Date(`${ticket.travel_date}T00:00:00`).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long",year:"numeric"}):"";
  const shortReference=ticket?.reference ? ticket.reference.slice(-8).toUpperCase() : "";
  // A boarding pass must never invent trip details. Missing fields render as a
  // dash so a passenger is never shown a route, coach or time we were not given.
  const filled = (value?: string) => value && value.trim() ? value : "—";
  const routeFrom = filled(ticket?.route_from);
  const routeTo = filled(ticket?.route_to);
  const hasRoute = routeFrom !== "—" || routeTo !== "—";
  const departureLabel = ticket?.departure_time ? formatTime(ticket.departure_time) : "—";

  const downloadTicketImage=async()=>{
    const node=ticketRef.current;
    if(!node || !ticket) return;
    setImageSaving(true);
    try {
      const clone=node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("svg").forEach((icon)=>icon.remove());
      clone.setAttribute("xmlns","http://www.w3.org/1999/xhtml");
      const rect=node.getBoundingClientRect();
      const width=Math.ceil(rect.width);
      const height=Math.ceil(rect.height);
      const markup=new XMLSerializer().serializeToString(clone);
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
      const image=new Image();
      const blob=new Blob([svg],{type:"image/svg+xml;charset=utf-8"});
      const url=URL.createObjectURL(blob);
      await new Promise<void>((resolve,reject)=>{ image.onload=()=>resolve(); image.onerror=reject; image.src=url; });
      const canvas=document.createElement("canvas");
      const scale=Math.max(2, window.devicePixelRatio || 1);
      canvas.width=width*scale;
      canvas.height=height*scale;
      const context=canvas.getContext("2d");
      if(!context) throw new Error("Image export is not supported on this device.");
      context.scale(scale,scale);
      context.fillStyle="#ffffff";
      context.fillRect(0,0,width,height);
      context.drawImage(image,0,0,width,height);
      URL.revokeObjectURL(url);
      const pngUrl=canvas.toDataURL("image/png");
      const link=document.createElement("a");
      link.href=pngUrl;
      link.download=`umatexpress-ticket-${shortReference || ticket.reference}.png`;
      link.click();
    } catch {
      window.print();
    } finally {
      setImageSaving(false);
    }
  };

  return <main className="status-page"><div className={`status-card ${state==="success"?"ticket-status":""}`}><img className="status-logo" src="/logo.svg" alt="UMaTeXPRESS" />
    {state==="checking"?<><LoaderCircle className="spin"/><h1>Generating your ticket</h1><p>Confirming your payment and preparing your ticket.</p></>:
    state==="success"&&ticket?<><CheckCircle2 className="status-icon success"/><h1>Trip confirmed!</h1><p>Your official UmateXPRESS ticket is ready.</p>
      <article className="travel-ticket image-ticket" ref={ticketRef}>
        <div className="ticket-watermark">UMaTeXPRESS</div>
        <div className="ticket-head"><div className="ticket-brand"><img src="/logo.svg" alt="" /><div><strong>vacationRide</strong><small>{ticket.trip_title || "vacationRide ticket"}</small></div></div><span><ShieldCheck size={14}/> PAID</span></div>
        <div className="ticket-hero"><div><small>BOARDING PASS</small><h2>{hasRoute ? <>{routeFrom} <em>to</em> {routeTo}</> : "Route details unavailable"}</h2><p>Present this image before boarding. Arrive 30 minutes early.</p></div><div className="ticket-seat-card"><small>SEAT</small><strong>{filled(ticket.seat)}</strong></div></div>
        <div className="ticket-route"><div><small>FROM</small><strong>{routeFrom}</strong><span>Departure point</span></div><BusFront/><div><small>TO</small><strong>{routeTo}</strong><span>Destination</span></div></div>
        <div className="ticket-details"><div><small>PASSENGER</small><strong>{filled(ticket.passenger_name)}</strong></div><div><small>TRAVEL DATE</small><strong>{date||"—"}</strong></div><div><small>DEPARTURE</small><strong>{departureLabel}</strong></div>{arrival&&<div><small>ARRIVAL</small><strong>{arrival}</strong></div>}<div><small>COACH</small><strong>{filled(ticket.coach_type)}</strong></div><div><small>TICKET PRICE</small><strong>GH₵{(Number(ticket.amount)/100).toFixed(2)}</strong></div></div>
        <div className="ticket-code"><div><small>REFERENCE</small><span>{ticket.reference}</span></div><strong>{shortReference}</strong></div>
      </article>
      <div className="ticket-actions"><button onClick={downloadTicketImage} disabled={imageSaving}><ImageDown size={17}/>{imageSaving ? "Saving image…" : "Save ticket image"}</button><button onClick={()=>window.print()}><Download size={17}/> Print</button><Link href="/">Return home</Link></div>
    </>:state==="review"?<><XCircle className="status-icon fail"/><h1>Payment received—seat review needed</h1><p>Your payment arrived after the seat hold expired. Support will confirm another seat or arrange a refund.</p><Link href="/">Return home</Link></>:
    <><XCircle className="status-icon fail"/><h1>Payment not completed</h1><p>No confirmed payment was found. You can safely try again.</p><Link href="/vacation#booking">Return to booking</Link></>}
  </div></main>;
}
