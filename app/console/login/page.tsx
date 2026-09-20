"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { AuthRecoveryCard } from "@/components/account/AuthRecoveryCard";

export default function ConsoleLoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [withCode, setWithCode] = useState(false);

  if (withCode) return <AuthRecoveryCard scope="CONSOLE" mode="otp" variant="console" next="/console" />;

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/console/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: identifier, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sign-in failed.");
      router.replace(data.mustChangePassword ? "/console/change-password" : "/console");
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Sign-in failed.");
      setSubmitting(false);
    }
  };

  return <main className="console-auth-page">
    <form className="console-auth-card" onSubmit={submit}>
      <img src="/logo-web.png" alt="UMaTeXPRESS" />
      <p>UMATEXPRESS CONSOLE</p>
      <h1>Sign in</h1>
      <span>One account for admin, moderator, organizer and driver services.</span>
      <label>Email or phone<input type="text" autoComplete="username" required value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={submitting}><LockKeyhole size={17} />{submitting ? "Signing in…" : "Sign in"}</button>
      <small>Every service starts here. Apply for the service you want to run, or sign in with the account your team set up.</small>
      <Link href="/console/register">Apply or request access</Link>
      <Link href="/console/reset-password">Forgot your password?</Link>
      <button type="button" className="console-auth-alt" onClick={() => setWithCode(true)}>Email me a sign-in code instead</button>
      <Link href="/console">Already signed in? Open the console</Link>
    </form>
  </main>;
}
