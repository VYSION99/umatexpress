"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

export default function ResetAdminPasswordPage() {
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword !== confirmation) {
      setError("The new admin password and confirmation do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reset", email, currentPassword, newPassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The administrator password could not be reset.");
      setSuccess("Admin password reset successfully. You can now sign in with the new password.");
      setEmail("");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "The administrator password could not be reset.");
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="admin-login-page">
    <form className="admin-login-card" onSubmit={submit}>
      <img className="login-logo" src="/logo-web.png" alt="UMaTeXPRESS" />
      <p>ADMIN SECURITY</p>
      <h1>Reset password</h1>
      <span>Use the admin account email and current password to create a new one.</span>

      <label>Email address
        <input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>Current password
        <input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
      </label>
      <label>New password
        <input type="password" autoComplete="new-password" required minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      </label>
      <label>Confirm new password
        <input type="password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>

      <small>Use uppercase, lowercase, a number, and a symbol.</small>
      {error && <div className="login-error">{error}</div>}
      {success && <div className="login-success">{success}</div>}
      <button disabled={submitting}>{submitting ? "Resetting…" : "Reset password"}</button>
      <Link href="/console/login">Back to sign in</Link>
    </form>
  </main>;
}
