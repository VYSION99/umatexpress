"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CampusRideMatch } from "@/lib/campus-matching";
import { clearProfile, readProfile, writeProfile } from "@/lib/passenger-profile";

export function QueueJoinCard({ match, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude }: { match: CampusRideMatch; pickupZoneId: string; destinationZoneId: string; pickupLatitude?: number; pickupLongitude?: number }) {
  const [open, setOpen] = useState(false);
  const [passengerName, setPassengerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const { ready: accountReady, account } = useStudentAccount();

  // Comfort: repeat riders should never retype their details. This reads the
  // same device-local profile the homepage and vacationRide use, after mount so
  // the server-rendered form never ships someone else's saved details.
  useEffect(() => {
    queueMicrotask(() => {
      const saved = readProfile();
      if (!saved) return;
      setPassengerName(saved.name);
      setPhone(saved.phone);
      setEmail(saved.email);
      setRemembered(Boolean(saved.name || saved.phone));
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Joining a queue starts a payment. The server enforces this too; this hop
    // just keeps the student from filling the form before being told.
    if (!account) { window.location.assign(`/account?next=${encodeURIComponent("/campus")}`); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/campus/queue/initialize", {
        method:"POST",
        credentials:"same-origin",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({ passengerName, phone, email, pickupZoneId, destinationZoneId, rideId: match.id, pickupLatitude, pickupLongitude }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not join ride queue.");
      writeProfile({ name: passengerName, email, phone });
      const url = data.queue?.authorizationUrl;
      if (url) window.location.href = url;
      else if (data.queue?.paymentReference) window.location.href = `/campus/ticket?reference=${encodeURIComponent(data.queue.paymentReference)}`;
      else setError(data.queue?.message || "Queue request created.");
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Could not join ride queue.");
    } finally {
      setLoading(false);
    }
  };

  const forgetDetails = () => {
    clearProfile();
    setPassengerName(""); setPhone(""); setEmail(""); setRemembered(false);
  };

  if (!open) return accountReady && !account
    ? <Link href={`/account?next=${encodeURIComponent("/campus")}`}>Sign in to join queue</Link>
    : <button onClick={()=>setOpen(true)}>Join queue & pay</button>;
  return <form className="queue-join-form" onSubmit={submit}>
    <strong>Join {match.corridor?.name || "campus ride"}</strong>
    <input required value={passengerName} onChange={(event)=>setPassengerName(event.target.value)} placeholder="Passenger name" />
    <input required value={phone} onChange={(event)=>setPhone(event.target.value)} placeholder="Phone number" />
    <input type="email" value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="Email optional" />
    {remembered && <small className="queue-join-remembered">These details are saved on this device. <button type="button" className="queue-join-forget" onClick={forgetDetails}>Forget</button></small>}
    {error && <small>{error}</small>}
    <div><button disabled={loading}>{loading ? "Starting payment..." : "Continue to Paystack"}</button><button type="button" onClick={()=>setOpen(false)}>Cancel</button></div>
  </form>;
}
