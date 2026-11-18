"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import { useStudentEligibility } from "@/components/account/useStudentEligibility";
import { FilmSlate, Lock, UploadSimple } from "@/components/ui/MaterialIcon";
import { findCinemaPlanFit } from "@/lib/cinema-engine/plan-fit";
import "./cinema.css";

type Plan = { code: string; label: string; description: string; files: number; bytes: number; minutes: number; pricePesewas: number; checkoutPesewas: number; available: boolean; eligible: boolean; eligibilityMessage: string };
type Catalogue = { current: { plan: string; validUntil: string }; pending: { plan: string; reference: string; checkoutUrl: string; checkoutPesewas: number } | null; plans: Plan[]; periodDays: number; uploadsEnabled: boolean; perFile: { bytes: number; minutes: number } };
const money = (pesewas: number) => `GH₵${(pesewas / 100).toFixed(2)}`;
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

function CinemaPlanFinder({ catalogue }: { catalogue: Catalogue }) {
  const [files, setFiles] = useState("");
  const [megabytes, setMegabytes] = useState("");
  const [minutes, setMinutes] = useState("");
  const needs = { files: Number(files), bytes: Number(megabytes) * 1024 ** 2, minutes: Number(minutes) };
  const ready = Number.isSafeInteger(Number(megabytes)) && Object.values(needs).every(value => Number.isSafeInteger(value) && value > 0);
  const fit = ready && catalogue.uploadsEnabled ? findCinemaPlanFit(catalogue.plans, catalogue.current.plan, needs, catalogue.perFile) : null;
  const awaitingCheckout = Boolean(catalogue.pending);
  const hasPaidPlan = catalogue.current.plan !== "FREE";
  return <section className="cinema-plan-finder" aria-labelledby="cinema-plan-finder-title">
    <h3 id="cinema-plan-finder-title">Find the lowest-cost plan for your room</h3>
    <p>Enter the totals for one playlist. This compares your room’s needs against the published checkout prices.</p>
    {!catalogue.uploadsEnabled ? <p>File uploads are currently closed.</p> : <>
      <div className="cinema-plan-finder-inputs">
        <label>Number of videos<input type="number" min="1" step="1" inputMode="numeric" value={files} onChange={event => setFiles(event.target.value)} placeholder="e.g. 3" /></label>
        <label>Total size (MB)<input type="number" min="1" step="1" inputMode="numeric" value={megabytes} onChange={event => setMegabytes(event.target.value)} placeholder="e.g. 1500" /></label>
        <label>Total length (minutes)<input type="number" min="1" step="1" inputMode="numeric" value={minutes} onChange={event => setMinutes(event.target.value)} placeholder="e.g. 90" /></label>
      </div>
      <p className="cinema-plans-note">Each individual video is also subject to the {size(catalogue.perFile.bytes)} and {catalogue.perFile.minutes}-minute upload limits. Enter whole numbers and round size and length up.</p>
      <div aria-live="polite" aria-atomic="true">
        {fit?.kind === "current" && <p className="cinema-plan-current"><strong>{fit.plan.label}</strong> fits these totals. You don’t need to buy another plan.</p>}
        {fit?.kind === "recommended" && <p className="cinema-plan-current"><strong>{fit.plan.label}</strong> is the lowest-cost eligible plan for these totals at <strong>{money(fit.plan.checkoutPesewas)}</strong> for {catalogue.periodDays} days. {awaitingCheckout ? "Resolve your pending checkout first." : hasPaidPlan ? "You can choose it after your current plan expires." : <a href={`#cinema-plan-${fit.plan.code}`}>View plan</a>}</p>}
        {fit?.kind === "approval" && <p className="cinema-plan-current"><strong>{fit.plan.label}</strong> fits these totals at {money(fit.plan.checkoutPesewas)} for {catalogue.periodDays} days. {fit.plan.eligibilityMessage}</p>}
        {fit?.kind === "file-limit" && <p className="cinema-plan-current">At least one video would exceed a per-file limit with these totals. Try smaller or shorter files.</p>}
        {fit?.kind === "closed" && <p className="cinema-plan-current">Plans that fit these totals are currently closed for checkout.</p>}
        {fit?.kind === "no-fit" && <p className="cinema-plan-current">No room plan fits these totals. Try splitting the playlist across rooms.</p>}
      </div>
    </>}
  </section>;
}

export function CinemaRoomPlansPage() {
  const { ready, account } = useStudentAccount();
  const studentEligible = useStudentEligibility(account);
  if (!ready) return <section className="cinema-card" role="status">Checking your account…</section>;
  if (!account) return <section className="cinema-card cinema-plan-signin"><h2>Choose a room plan</h2><p>Sign in with your student account to see your room allowance and subscribe.</p><Link className="cinema-cta" href="/account?next=%2Fcinema%2Frooms%2Fplans">Sign in</Link></section>;
  if (account.verificationRequired && !account.emailVerified) return <section className="cinema-card cinema-plan-signin"><h2>Verify your email</h2><p>Finish account email verification before subscribing to a Cinema room plan.</p><Link className="cinema-cta" href="/account?next=%2Fcinema%2Frooms%2Fplans">Verify email</Link></section>;
  if (studentEligible === null) return <section className="cinema-card" role="status">Checking student access…</section>;
  if (!studentEligible) return <section className="cinema-card cinema-plan-signin"><h2>Student room plans</h2><p>Verify a UMaT student email on your account to host watch rooms and subscribe to room plans.</p><Link className="cinema-cta" href="/account?next=%2Fcinema%2Frooms%2Fplans">Verify student email</Link></section>;
  return <AccountRoomPlans key={account.id} />;
}

function AccountRoomPlans() {
  const lifetime = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async (signal: AbortSignal) => {
    const sequence = ++loadSequence.current;
    const response = await fetch("/api/cinema/room-plans", { credentials: "same-origin", cache: "no-store", signal });
    const result = await response.json() as Catalogue & { error?: string };
    if (!response.ok) throw new Error(result.error || "Room plans could not be loaded.");
    if (!signal.aborted && sequence === loadSequence.current) setCatalogue(result);
  }, []);
  const verify = useCallback(async (reference: string) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy("verify"); setError("");
    try {
      const response = await fetch(`/api/cinema/room-plans/${encodeURIComponent(reference)}`, { credentials: "same-origin", cache: "no-store", signal });
      const result = await response.json() as { status?: string; error?: string };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(result.error || "The payment could not be checked.");
      setNotice(result.status === "ACTIVE" ? "Your room plan is active. New rooms will use its limits." : result.status === "PENDING" ? "The payment is still pending. Check again after completing checkout." : "The payment did not activate a plan. You can start a new checkout.");
      await load(signal);
    } catch (problem) { if (!signal.aborted) setError(problem instanceof Error ? problem.message : "The payment could not be checked."); }
    finally { if (!signal.aborted) setBusy(""); }
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const timer = setTimeout(() => {
      void load(controller.signal).catch(problem => { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : "Room plans could not be loaded."); });
      const reference = new URL(window.location.href).searchParams.get("reference");
      if (reference) void verify(reference);
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load, verify]);
  const startCheckout = async (plan: Plan) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(plan.code); setError(""); setNotice("");
    try {
      const response = await fetch("/api/cinema/room-plans", {
        method: "POST", credentials: "same-origin", signal,
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ plan: plan.code, expectedCheckoutPesewas: plan.checkoutPesewas }),
      });
      const result = await response.json() as { authorizationUrl?: string; error?: string };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(result.error || "Checkout could not be started.");
      if (!result.authorizationUrl) throw new Error("Checkout is being prepared. Please check your plan status shortly.");
      window.location.assign(result.authorizationUrl);
    } catch (problem) {
      if (signal.aborted) return;
      setError(problem instanceof Error ? problem.message : "Checkout could not be started.");
      setBusy("");
      await load(signal).catch(() => undefined);
    }
  };
  return <div className="cinema-plans-page">
    <div className="cinema-plans-heading"><div><span className="cinema-eyebrow">CINEMA WATCH ROOMS</span><h2>Compare room upload plans</h2><p>Choose how many videos you can upload per room. Paid plans last {catalogue?.periodDays ?? 30} days and do not renew automatically. Watching public Cinema events is free.</p></div><Link href="/cinema/rooms">Back to rooms</Link></div>
    {error && <p className="cinema-error" role="alert">{error}</p>}
    {notice && <p className="cinema-recovery" role="status">{notice}</p>}
    {catalogue && catalogue.current.plan !== "FREE" && <p className="cinema-plan-current">Current plan: <strong>{catalogue.plans.find(plan => plan.code === catalogue.current.plan)?.label || catalogue.current.plan}</strong>{catalogue.current.validUntil && <> · Ends {new Date(catalogue.current.validUntil).toLocaleDateString()}</>}</p>}
    {catalogue?.pending && <div className="cinema-plan-pending"><strong>Checkout in progress</strong><p>{catalogue.plans.find(plan => plan.code === catalogue.pending?.plan)?.label || "Room plan"} · {money(catalogue.pending.checkoutPesewas)} quoted at checkout</p><div>{catalogue.pending.checkoutUrl && <a href={catalogue.pending.checkoutUrl}>Continue payment</a>}<button type="button" disabled={Boolean(busy)} onClick={() => void verify(catalogue.pending!.reference)}>Check payment</button></div></div>}
    {catalogue && <CinemaPlanFinder catalogue={catalogue} />}
    <div className="cinema-plan-grid">{catalogue ? catalogue.plans.map(plan => <article id={`cinema-plan-${plan.code}`} className={`cinema-plan-card${plan.code === "STUDENT_PLUS" ? " is-featured" : ""}`} key={plan.code}>
      <span className="cinema-plan-icon">{plan.code === "FREE" ? <FilmSlate size={24} aria-hidden /> : plan.code === "STUDENT_PLUS" ? <UploadSimple size={24} aria-hidden /> : <Lock size={24} aria-hidden />}</span>
      <h3>{plan.label}</h3><p>{plan.description}</p>
      <div className="cinema-plan-price">{plan.code === "FREE" ? "Free" : plan.available ? money(plan.checkoutPesewas) : "Unavailable"}{plan.code !== "FREE" && plan.available && <small>/ {catalogue.periodDays} days</small>}</div>
      <ul><li>Queue up to {plan.files} video{plan.files === 1 ? "" : "s"} per room</li><li>{size(plan.bytes)} total per room</li><li>Up to {plan.minutes / 60} hour{plan.minutes === 60 ? "" : "s"} of video</li></ul>
      {plan.code !== "FREE" && plan.available && <p className="cinema-plan-checkout-total">{money(plan.pricePesewas)} plan price + {money(plan.checkoutPesewas - plan.pricePesewas)} processing fee</p>}
      {catalogue.current.plan === plan.code ? <span className="cinema-plan-active">Your current plan</span> : plan.code === "FREE" ? <Link className="cinema-plan-action" href="/cinema/rooms">Create a free room</Link> : !plan.available || !catalogue.uploadsEnabled ? <span className="cinema-plan-unavailable">Checkout is currently closed</span> : !plan.eligible ? <span className="cinema-plan-unavailable">{plan.eligibilityMessage}</span> : <button type="button" className="cinema-plan-action" disabled={Boolean(busy) || Boolean(catalogue.pending) || catalogue.current.plan !== "FREE"} onClick={() => void startCheckout(plan)}>{busy === plan.code ? "Preparing checkout…" : "Continue to checkout"}</button>}
    </article>) : <p role="status">Loading room plans…</p>}</div>
    <p className="cinema-plans-note">Existing rooms keep their original upload limits. New rooms use your active plan.</p>
  </div>;
}
