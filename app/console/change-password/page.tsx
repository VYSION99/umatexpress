"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";

export default function ConsoleChangePasswordPage() {
  return <ConsoleSessionGate allowPasswordChange label="your session">{(session) => <ChangePasswordForm session={session} />}</ConsoleSessionGate>;
}

function ChangePasswordForm({ session }: { session: ConsoleSessionInfo }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const staff = session.account.role === "ADMIN" || session.account.role === "MODERATOR";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setError("The two new passwords do not match."); return; }
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/console/session", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The password could not be changed.");
      router.replace("/console");
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "The password could not be changed.");
      setSubmitting(false);
    }
  };

  return <main className="console-auth-page">
    <form className="console-auth-card" onSubmit={submit}>
      <img src="/logo.svg" alt="UMaTeXPRESS" />
      <p>UMATEXPRESS CONSOLE</p>
      <h1>{session.mustChangePassword ? "Set your password" : "Change your password"}</h1>
      <span>
        {session.mustChangePassword
          ? "This account is still using a temporary password. Choose your own before continuing."
          : `Signed in as ${session.account.email}.`}
      </span>
      <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={submitting}><KeyRound size={17} />{submitting ? "Saving…" : "Save new password"}</button>
      <small>At least {staff ? 12 : 10} characters with uppercase, lowercase, a number and a symbol. Changing the password signs out every other device.</small>
    </form>
  </main>;
}
