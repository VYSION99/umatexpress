"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { ShieldCheck, SignOut } from "@/components/ui/MaterialIcon";
import { STUDENT_EMAIL_DOMAIN, validStudentEmail } from "@/lib/student-email";
import type { StudentAccount } from "@/lib/student-auth";
import { requiresStudentAccess, safeAuthReturnPath } from "@/lib/auth-return";
import { clearProfile, clearSavedTickets, notifyPassengerChanged, writeProfile } from "@/lib/passenger-profile";
import { loadStudentAccount, publishStudentAccount, useStudentAccount } from "./useStudentAccount";
import { CodeBoxes } from "./CodeBoxes";
import { PasskeySettings, PasskeySignInButton } from "./PasskeyControls";
import { StudentEmailAccess } from "./StudentEmailAccess";
import "./account.css";

type Mode = "signin" | "signup";

export function StudentAuthCard({ next }: { next?: string }) {
  const destination = safeAuthReturnPath(next);
  const returnQuery = destination === "/" ? "" : `next=${encodeURIComponent(destination)}`;
  const cinemaAudience = destination.startsWith("/cinema/") || destination === "/cinema";
  const needsStudentEmail = requiresStudentAccess(destination);
  const accountReturn = `/account?next=${encodeURIComponent(destination)}`;
  const { ready, account } = useStudentAccount();
  const [mode, setMode] = useState<Mode>("signin");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [verificationBusy, setVerificationBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/auth/student", {
        method: mode === "signin" ? "POST" : "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "signin"
          ? { email: form.email, password: form.password }
          : { email: form.email, password: form.password, name: form.name }),
      });
      const data = await response.json() as { account?: StudentAccount; error?: string };
      if (!response.ok || !data.account) throw new Error(data.error || "That did not work. Please try again.");
      // Mirror the account into the device profile so booking forms fill instantly.
      writeProfile({ name: data.account.name, email: data.account.email, phone: data.account.phone });
      publishStudentAccount(data.account);
      const verifyFirst = !data.account.emailVerified && (data.account.verificationRequired || cinemaAudience);
      const ineligibleForService = needsStudentEmail && !validStudentEmail(data.account.email);
      window.location.assign(mode === "signup" || verifyFirst || ineligibleForService ? accountReturn : destination);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "That did not work. Please try again.");
      setLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/student", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
      clearProfile(); clearSavedTickets(); notifyPassengerChanged();
      publishStudentAccount(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign out."); }
    setLoading(false);
    setForm({ email: "", password: "", name: "" });
  };

  const verifyEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (!account) return;
    setVerificationBusy(true); setVerificationError("");
    try {
      const response = await fetch("/api/auth/otp", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "STUDENT", email: account.email, code: verificationCode }) });
      if (!response.ok) throw new Error("That code is incorrect or expired. Request a new one.");
      const refreshed = await loadStudentAccount(true);
      publishStudentAccount(refreshed);
      if (refreshed?.emailVerified) window.location.assign(needsStudentEmail && !validStudentEmail(refreshed.email) ? accountReturn : destination);
    } catch (error) { setVerificationError(error instanceof Error ? error.message : "Could not verify email."); }
    finally { setVerificationBusy(false); }
  };

  const resendVerification = async () => {
    if (!account) return;
    setVerificationBusy(true); setVerificationError("");
    try {
      const response = await fetch("/api/auth/recovery", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "STUDENT", email: account.email }) });
      if (!response.ok) throw new Error("Could not send a code. Try again shortly.");
      setVerificationCode("");
      setVerificationError("A new code is on its way to your email.");
    } catch (error) { setVerificationError(error instanceof Error ? error.message : "Could not send a code."); }
    finally { setVerificationBusy(false); }
  };

  if (ready && account && !account.emailVerified && (account.verificationRequired || cinemaAudience)) {
    return <form className="campus-auth-card student-auth-signed-in" onSubmit={verifyEmail}>
      <h2>Verify your email</h2>
      <p>You are signed in as {account.email}. Enter the latest six-digit email code, or select <strong>Send a new code</strong> below to verify your address.</p>
      <CodeBoxes label="Verification code" value={verificationCode} onChange={setVerificationCode} disabled={verificationBusy} />
      {verificationError && <p role="status">{verificationError}</p>}
      <div className="student-auth-actions">
        <button className="is-primary" disabled={verificationBusy}>{verificationBusy ? "Checking…" : "Verify email"}</button>
        <button type="button" disabled={verificationBusy} onClick={() => void resendVerification()}>Send a new code</button>
        <button type="button" onClick={signOut} disabled={verificationBusy}>Sign out</button>
      </div>
    </form>;
  }

  if (ready && account) {
    const ineligibleForService = needsStudentEmail && !validStudentEmail(account.email);
    return <div className="campus-auth-card student-auth-signed-in">
      <strong>Signed in as {account.email}</strong>
      <small role={ineligibleForService ? "status" : undefined}>{ineligibleForService ? "Check or verify your UMaT student access below to continue with this account." : validStudentEmail(account.email) ? "Your UMaT email gives you access to student services." : "Your verified account is ready for public services."}</small>
      <div className="student-auth-actions">
        {!ineligibleForService && <Link className="is-primary" href={destination}>Continue</Link>}
        <button type="button" onClick={signOut} disabled={loading}><SignOut size={15} aria-hidden /> Sign out</button>
      </div>
      {!validStudentEmail(account.email) && <StudentEmailAccess accountId={account.id} destination={destination} required={needsStudentEmail} />}
      {account.emailVerified && <PasskeySettings scope="STUDENT" />}
    </div>;
  }

  return <form className="campus-auth-card" onSubmit={submit}>
    <div className="student-auth-tabs" role="group" aria-label="Account action">
      <button type="button" aria-pressed={mode === "signin"} onClick={() => { setMode("signin"); setError(""); }}>Sign in</button>
      <button type="button" aria-pressed={mode === "signup"} onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
    </div>
    <label>Email address<input required type="email" autoComplete="username" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>
    {mode === "signup" && <>
      <label>Full name<input required autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Ama Mensah" /></label>
    </>}
    <label>Password<input required type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={mode === "signin" ? "Your password" : "At least 10 characters"} /></label>
    {error && <p className="campus-ai-error" role="alert">{error}</p>}
    {(needsStudentEmail || mode === "signup") && <p className="student-auth-hint"><ShieldCheck size={14} aria-hidden /> {mode === "signup"
      ? `Any valid email can create an account. For student-only services, you can verify a @${STUDENT_EMAIL_DOMAIN} address afterward. Use uppercase, lowercase, a number and a symbol in your password.`
      : `Student-only services require a verified @${STUDENT_EMAIL_DOMAIN} address. You can add it to this account after signing in.`}</p>}
    <button disabled={loading}>{loading ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}</button>
    {mode === "signin" && <div className="student-auth-alternatives" aria-label="Other ways to sign in">
      <div className="student-auth-divider"><span>Other ways to sign in</span></div>
      <PasskeySignInButton scope="STUDENT" onSuccess={() => { void loadStudentAccount(true).then(account => window.location.assign(!account || needsStudentEmail && !validStudentEmail(account.email) ? accountReturn : destination)); }} />
      <div className="student-auth-recovery-links">
        <Link className="student-auth-forgot" href={`/reset-password?mode=otp${returnQuery ? `&${returnQuery}` : ""}`}>Use a one-time code</Link>
        <Link className="student-auth-forgot" href={`/reset-password${returnQuery ? `?${returnQuery}` : ""}`}>Forgot password?</Link>
      </div>
    </div>}
  </form>;
}
