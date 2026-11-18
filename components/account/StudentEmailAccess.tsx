"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { STUDENT_EMAIL_DOMAIN } from "@/lib/student-email";
import "./account.css";

type Access = { studentEmail: string; verified: boolean; expiresAt: string };

export function StudentEmailAccess({ accountId, destination, required }: { accountId: string; destination: string; required: boolean }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [checking, setChecking] = useState(true);
  const [studentEmail, setStudentEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/student/eligibility", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Could not check student access. Try again shortly.");
        return response.json() as Promise<{ studentAccess: Access }>;
      })
      .then(data => { if (!controller.signal.aborted) { setAccess(data.studentAccess); setStudentEmail(data.studentAccess.studentEmail); } })
      .catch(() => { if (!controller.signal.aborted) setError("Could not check student access. Refresh this page to try again."); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [accountId]);

  async function send(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/auth/student/eligibility", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentEmail }) });
      const data = await response.json() as { studentAccess?: Access; error?: string };
      if (!response.ok || !data.studentAccess) throw new Error(data.error || "Could not send the code.");
      setAccess(data.studentAccess);
      setMessage(`A six-digit code is on its way to ${data.studentAccess.studentEmail}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send the code."); }
    finally { setBusy(false); }
  }

  async function verify(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/auth/student/eligibility", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const data = await response.json() as { studentAccess?: Access; error?: string };
      if (!response.ok || !data.studentAccess) throw new Error(data.error || "Could not verify the code.");
      setAccess({ ...data.studentAccess, expiresAt: "" });
      setCode("");
      setMessage("Your UMaT student email is verified. Student services are ready on this account.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not verify the code."); }
    finally { setBusy(false); }
  }

  if (checking) return <section className="student-email-access" role="status">Checking student access…</section>;

  return <section className="student-email-access" aria-label="Student access">
    <div className="student-email-access-heading"><span>STUDENT ACCESS</span><h3>{access?.verified ? "Student email verified" : "Verify a UMaT student email"}</h3></div>
    {access?.verified ? <>
      <p>{access.studentEmail} is linked to this account. Your sign-in email stays the same.</p>
      {required && <Link className="student-email-continue" href={destination}>Continue to your selected service</Link>}
    </> : <>
      <p>Keep your current sign-in email. Add and verify your UMaT address to use student-only services.</p>
      <form onSubmit={send}>
        <label>UMaT student email<input required type="email" autoComplete="email" value={studentEmail} onChange={event => setStudentEmail(event.target.value)} placeholder={`your.name@${STUDENT_EMAIL_DOMAIN}`} /></label>
        <button disabled={busy}>{busy ? "Sending…" : access?.expiresAt ? "Send a new code" : "Send verification code"}</button>
      </form>
      {access?.expiresAt && <form onSubmit={verify}>
        <label>Six-digit code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label>
        <button disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify student email"}</button>
      </form>}
    </>}
    {message && <p className="student-email-message" role="status">{message}</p>}
    {error && <p className="student-email-error" role="alert">{error}</p>}
  </section>;
}
