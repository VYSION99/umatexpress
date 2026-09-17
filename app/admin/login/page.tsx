"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { LockKeyhole } from "lucide-react";

export default function AdminLoginPage() {
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [submitting,setSubmitting]=useState(false);

  const submit=async(event:FormEvent)=>{
    event.preventDefault(); setSubmitting(true); setError("");
    try {
      const response=await fetch("/api/admin/auth",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Sign-in failed.");
      const targetRoute = data.mustChangePassword ? "/admin/change-password" : "/admin";
      window.location.assign(targetRoute);
    } catch (signInError) {
      setError(signInError instanceof Error?signInError.message:"Sign-in failed.");
    } finally { setSubmitting(false); }
  };

  return <main className="admin-login-page"><form className="admin-login-card" onSubmit={submit}>
    <img className="login-logo" src="/logo.svg" alt="UMaTeXPRESS" /><p>UMATEXPRESS ADMIN</p><h1>Welcome back</h1><span>Sign in with an administrator account.</span>
    <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event)=>setEmail(event.target.value)}/></label>
    <label>Password<input type="password" autoComplete="current-password" required minLength={10} value={password} onChange={(event)=>setPassword(event.target.value)}/></label>
    {error&&<div className="login-error">{error}</div>}
    <button disabled={submitting}><LockKeyhole size={17}/>{submitting?"Signing in…":"Sign in"}</button>
    <Link href="/admin/reset-password">Reset password with current password</Link>
    <Link href="/">Return to client home</Link>
  </form></main>;
}
