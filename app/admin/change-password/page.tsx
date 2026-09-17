"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function ChangeAdminPasswordPage() {
  const router=useRouter();
  const [currentPassword,setCurrentPassword]=useState("");
  const [newPassword,setNewPassword]=useState("");
  const [confirmation,setConfirmation]=useState("");
  const [error,setError]=useState("");
  const [submitting,setSubmitting]=useState(false);

  useEffect(()=>{ queueMicrotask(async()=>{ const response=await fetch("/api/admin/auth",{cache:"no-store",credentials:"same-origin"}); if(!response.ok) router.replace("/admin/login"); }); },[router]);

  const submit=async(event:FormEvent)=>{
    event.preventDefault(); setError("");
    if(newPassword!==confirmation){setError("The new passwords do not match.");return;}
    setSubmitting(true);
    try{
      const response=await fetch("/api/admin/auth",{method:"PATCH",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({mode:"reset",currentPassword,newPassword})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Password could not be reset.");
      window.location.assign("/admin");
    }catch(changeError){setError(changeError instanceof Error?changeError.message:"Password could not be reset.");}
    finally{setSubmitting(false);}
  };

  return <main className="admin-login-page"><form className="admin-login-card" onSubmit={submit}>
    <img className="login-logo" src="/logo.svg" alt="UMaTeXPRESS" /><p>ADMIN SECURITY</p><h1>Change password</h1><span>Replace your current administrator password with a stronger one.</span>
    <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event)=>setCurrentPassword(event.target.value)}/></label>
    <label>New password<input type="password" autoComplete="new-password" required minLength={12} value={newPassword} onChange={(event)=>setNewPassword(event.target.value)}/></label>
    <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={(event)=>setConfirmation(event.target.value)}/></label>
    <small>Use uppercase, lowercase, a number, and a symbol.</small>
    {error&&<div className="login-error">{error}</div>}
    <button disabled={submitting}>{submitting?"Updating…":"Change password"}</button>
  </form></main>;
}
