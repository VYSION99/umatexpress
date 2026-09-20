"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import { STUDENT_EMAIL_DOMAIN } from "@/lib/student-email";
import type { StudentAccount } from "@/lib/student-auth";
import { writeProfile } from "@/lib/passenger-profile";
import { publishStudentAccount, useStudentAccount } from "./useStudentAccount";
import "./account.css";

type Mode = "signin" | "signup";

/**
 * Only same-site destinations are accepted, so `?next=` cannot be used to bounce
 * a freshly signed-in student to another origin.
 */
export function safeNext(value?: string) {
  const next = String(value || "");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function StudentAuthCard({ next }: { next?: string }) {
  const destination = safeNext(next);
  const { ready, account } = useStudentAccount();
  const [mode, setMode] = useState<Mode>("signin");
  const [form, setForm] = useState({ email: "", password: "", name: "", phone: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
          : { email: form.email, password: form.password, name: form.name, phone: form.phone }),
      });
      const data = await response.json() as { account?: StudentAccount; error?: string };
      if (!response.ok || !data.account) throw new Error(data.error || "That did not work. Please try again.");
      // Mirror the account into the device profile so booking forms fill instantly.
      writeProfile({ name: data.account.name, email: data.account.email, phone: data.account.phone });
      publishStudentAccount(data.account);
      window.location.assign(destination);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "That did not work. Please try again.");
      setLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);
    try { await fetch("/api/auth/student", { method: "DELETE", credentials: "same-origin" }); } catch { /* the cookie is cleared server-side when the network returns */ }
    publishStudentAccount(null);
    setLoading(false);
    setForm({ email: "", password: "", name: "", phone: "" });
  };

  if (ready && account) {
    return <div className="campus-auth-card student-auth-signed-in">
      <strong>Signed in as {account.email}</strong>
      <small>{account.name ? `Booking as ${account.name}.` : "Add your name when you book."} This account covers campusRide and vacationRide.</small>
      <div className="student-auth-actions">
        <Link className="is-primary" href={destination}>Continue</Link>
        <button type="button" onClick={signOut} disabled={loading}><LogOut size={15} aria-hidden /> Sign out</button>
      </div>
    </div>;
  }

  return <form className="campus-auth-card" onSubmit={submit}>
    <div className="student-auth-tabs" role="group" aria-label="Account action">
      <button type="button" aria-pressed={mode === "signin"} onClick={() => { setMode("signin"); setError(""); }}>Sign in</button>
      <button type="button" aria-pressed={mode === "signup"} onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
    </div>
    <label>UMaT student email<input required type="email" autoComplete="username" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder={`your.name@${STUDENT_EMAIL_DOMAIN}`} /></label>
    {mode === "signup" && <>
      <label>Full name<input required autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Ama Mensah" /></label>
      <label>Mobile Money number<input inputMode="tel" autoComplete="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="05X XXX XXXX" /></label>
    </>}
    <label>Password<input required type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={mode === "signin" ? "Your password" : "At least 10 characters"} /></label>
    {error && <p className="campus-ai-error" role="alert">{error}</p>}
    <p className="student-auth-hint"><ShieldCheck size={14} aria-hidden /> {mode === "signin"
      ? "Only UMaT student addresses ending in @st.umat.edu.gh can hold an account."
      : `Accounts are limited to @${STUDENT_EMAIL_DOMAIN}. Use uppercase, lowercase, a number and a symbol in the password.`}</p>
    <button disabled={loading}>{loading ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}</button>
    {mode === "signin" && <>
      <Link className="student-auth-forgot" href="/reset-password">Forgot your password?</Link>
      <Link className="student-auth-forgot" href="/reset-password?mode=otp">Or sign in with a one-time code</Link>
    </>}
  </form>;
}
