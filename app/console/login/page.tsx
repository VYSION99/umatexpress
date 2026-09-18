"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";

export default function ConsoleLoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
      <img src="/logo.svg" alt="UMaTeXPRESS" />
      <p>UMATEXPRESS CONSOLE</p>
      <h1>Sign in</h1>
      <span>One account for admin, moderator, organizer and driver services.</span>
      <label>Email or phone<input type="text" autoComplete="username" required value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={submitting}><LockKeyhole size={17} />{submitting ? "Signing in…" : "Sign in"}</button>
      <small>Organizers apply from this page and sign in once an administrator approves the application.</small>
      <Link href="/console/register">Want to organise coaches? Apply here</Link>
      <Link href="/console">Already signed in? Open the console</Link>
    </form>
  </main>;
}
