"use client";

import { FormEvent, useState } from "react";

export function DriverLoginForm() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/driver/auth", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify({ identifier, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Driver sign-in failed.");
      window.location.assign("/driver");
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Driver sign-in failed.");
    } finally {
      setLoading(false);
    }
  };

  return <form className="campus-auth-card" onSubmit={submit}>
    <label>Phone or email<input required autoComplete="username" value={identifier} onChange={(event)=>setIdentifier(event.target.value)} placeholder="Phone number or email" /></label>
    <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="Enter your driver password" /></label>
    {error && <p className="campus-ai-error" role="alert">{error}</p>}
    <button disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
  </form>;
}
