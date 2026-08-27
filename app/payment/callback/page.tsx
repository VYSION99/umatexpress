"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { formatTime } from "@/lib/trips";
import { BusFront, CheckCircle2, Download, LoaderCircle, XCircle } from "lucide-react";

 type Ticket = { reference:string; passenger_name:string; seat:string; trip_id:string; travel_date:string; departure_time:string; amount:string };

export default function PaymentCallback() {
  const [state, setState] = useState<"checking"|"success"|"failed"|"review">("checking");
  const [ticket,setTicket]=useState<Ticket|null>(null);
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
          if(data.status==="SUCCESSFUL"&&data.ticket){setTicket(data.ticket);setState("success");return;}
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
  const departure=ticket?.departure_time ? formatTime(ticket.departure_time) : ticket?.trip_id==="2" ? "1:00 PM" : "6:30 AM";
  const date=ticket?new Date(`${ticket.travel_date}T00:00:00`).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long",year:"numeric"}):"";

  return <main className="status-page"><div className={`status-card ${state==="success"?"ticket-status":""}`}><span className="brand-mark"><BusFront/></span>
    {state==="checking"?<><LoaderCircle className="spin"/><h1>Generating your ticket</h1><p>Confirming your payment and preparing your ticket.</p></>:
    state==="success"&&ticket?<><CheckCircle2 className="status-icon success"/><h1>Trip confirmed!</h1><p>Your official UmateXPRESS ticket is ready.</p>
      <article className="travel-ticket">
        <div className="ticket-head"><div><strong>Umate<span>XPRESS</span></strong><small>STUDENT VACATION TICKET</small></div><span>PAID</span></div>
        <div className="ticket-route"><div><small>FROM</small><strong>UMaT Main Campus</strong><span>Tarkwa</span></div><BusFront/><div><small>TO</small><strong>Accra</strong><span>General destination</span></div></div>
        <div className="ticket-details"><div><small>PASSENGER</small><strong>{ticket.passenger_name}</strong></div><div><small>TRAVEL DATE</small><strong>{date}</strong></div><div><small>DEPARTURE</small><strong>{departure}</strong></div><div><small>SEAT</small><strong className="ticket-seat">{ticket.seat}</strong></div><div><small>TICKET PRICE</small><strong>GH₵{(Number(ticket.amount)/100).toFixed(2)}</strong></div><div><small>REFERENCE</small><strong>{ticket.reference}</strong></div></div>
        <div className="ticket-code"><span>{ticket.reference}</span><small>Present this ticket before boarding · Arrive 30 minutes early</small></div>
      </article>
      <div className="ticket-actions"><button onClick={()=>window.print()}><Download size={17}/> Download / Print ticket</button><Link href="/">Return home</Link></div>
    </>:state==="review"?<><XCircle className="status-icon fail"/><h1>Payment received—seat review needed</h1><p>Your payment arrived after the seat hold expired. Support will confirm another seat or arrange a refund.</p><Link href="/">Return home</Link></>:
    <><XCircle className="status-icon fail"/><h1>Payment not completed</h1><p>No confirmed payment was found. You can safely try again.</p><Link href="/#booking">Return to booking</Link></>}
  </div></main>;
}
