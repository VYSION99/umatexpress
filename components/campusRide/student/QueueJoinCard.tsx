"use client";

import { checkoutFetch } from "@/lib/checkout-client";
import { usePaymentQuote } from "@/lib/payment-quote-client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, X } from "@/components/ui/MaterialIcon";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CampusRideMatch } from "@/lib/campus-matching";
import { clearProfile, readProfile, writeProfile } from "@/lib/passenger-profile";
import { SheetHandle } from "@/components/ui/SheetHandle";

export function QueueJoinCard({ match, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude }: { match: CampusRideMatch; pickupZoneId: string; destinationZoneId: string; pickupLatitude?: number; pickupLongitude?: number }) {
  const router = useRouter();
  const reviewRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [passengerName, setPassengerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const { ready: accountReady, account } = useStudentAccount();
  const { quote, error: quoteError } = usePaymentQuote(Math.max(0, Math.round(match.fare || 0)));

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

  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account) { router.push(`/account?next=${encodeURIComponent("/campus")}`); return; }
    setError("");
    reviewRef.current?.showModal();
  };

  const beginPayment = async () => {
    if (loading || !account || !quote) return;
    reviewRef.current?.close();
    setLoading(true); setError("");
    try {
      const response = await checkoutFetch("/api/campus/queue/initialize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passengerName, phone, email, pickupZoneId, destinationZoneId, rideId: match.id, pickupLatitude, pickupLongitude }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not join ride queue.");
      writeProfile({ name: passengerName, email, phone });
      const url = data.queue?.authorizationUrl;
      if (url) window.location.href = url;
      else if (data.queue?.paymentReference) router.push(`/campus/ticket?reference=${encodeURIComponent(data.queue.paymentReference)}`);
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
    ? <Link className="campus-ride-signin" href={`/account?next=${encodeURIComponent("/campus")}`}>Sign in to join queue</Link>
    : <button type="button" onClick={() => setOpen(true)}>Join queue &amp; pay</button>;
  return <>
    <form className="queue-join-form" onSubmit={review}>
      <strong>Passenger details</strong>
      <p>Your ticket will use these details after payment is confirmed.</p>
      <label>Full name<input required autoComplete="name" value={passengerName} onChange={(event) => setPassengerName(event.target.value)} placeholder="Name on your ticket" /></label>
      <label>Mobile Money phone<input required type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone number" /></label>
      <label>Email <span>(optional)</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
      {remembered && <small className="queue-join-remembered">Details saved on this device. <button type="button" className="queue-join-forget" onClick={forgetDetails}>Forget</button></small>}
      {error && <small role="alert" className="campus-ride-payment-error">{error}</small>}
      <div className="queue-join-actions"><button type="submit" disabled={loading}>{loading ? "Starting payment..." : "Review and pay"}</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
    <dialog ref={reviewRef} className="campus-ride-dialog" aria-labelledby="campus-payment-review-title" onClick={(event) => { if (event.target === event.currentTarget) reviewRef.current?.close(); }}>
      <SheetHandle onDismiss={() => reviewRef.current?.close()} />
      <div className="campus-ride-dialog-content">
        <div className="campus-ride-dialog-head"><span>FINAL CHECK</span><button type="button" aria-label="Close payment review" onClick={() => reviewRef.current?.close()}><X size={19} aria-hidden /></button></div>
        <h2 id="campus-payment-review-title">Review your ride</h2>
        <p className="campus-ride-dialog-subtitle">Confirm these details before opening secure checkout.</p>
        <dl className="campus-ride-detail-list"><div><dt>Route</dt><dd>{match.corridor?.name || "Campus ride"}</dd></div><div><dt>Passenger</dt><dd>{passengerName}</dd></div><div><dt>Mobile Money phone</dt><dd>{phone}</dd></div>{email && <div><dt>Email</dt><dd>{email}</dd></div>}<div><dt>Flat fare</dt><dd>{match.fare > 0 ? `GH₵ ${(match.fare / 100).toFixed(2)}` : "Fare unavailable"}</dd></div><div><dt>Paystack processing ({quote?.feePercent ?? 1.95}%)</dt><dd>{quote ? `GH₵ ${(quote.feeAmount / 100).toFixed(2)}` : "Calculating…"}</dd></div><div><dt>Total to pay</dt><dd>{quote ? `GH₵ ${(quote.totalAmount / 100).toFixed(2)}` : "Calculating…"}</dd></div></dl>
        {quoteError && <p role="alert" className="campus-ride-payment-error">{quoteError}</p>}
        <p className="campus-ride-dialog-note">Payment activates a place in the ride queue. The payment provider shows the final amount before you approve it.</p>
        <div className="campus-ride-dialog-actions"><button type="button" className="campus-ride-dialog-primary" disabled={loading || !quote} onClick={() => void beginPayment()}>Continue to secure payment <ArrowRight size={17} aria-hidden /></button><button type="button" onClick={() => reviewRef.current?.close()}>Edit details</button></div>
      </div>
    </dialog>
  </>;
}
