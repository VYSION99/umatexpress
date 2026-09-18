"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { Store } from "lucide-react";

const FIELDS = [
  { key: "name", label: "Full name", type: "text", autoComplete: "name", required: true },
  { key: "organization", label: "Organisation (shown to students)", type: "text", autoComplete: "organization", required: false },
  { key: "phone", label: "Phone number", type: "tel", autoComplete: "tel", required: true },
  { key: "email", label: "Email address", type: "email", autoComplete: "email", required: true },
] as const;

/**
 * Organizer self-registration (decision D4). Anyone may apply; a reviewer has
 * to approve the application before the account can sign in, so this page
 * promises a review and never an account.
 */
export default function OrganizerRegisterPage() {
  const [form, setForm] = useState({ name: "", organization: "", phone: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState("");

  const update = (key: string) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/console/organizers/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The application could not be submitted.");
      setSubmitted(data.message || "Application received.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The application could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return <main className="console-auth-page">
      <section className="console-auth-card">
        <img src="/logo.svg" alt="UMaTeXPRESS" />
        <p>UMATEXPRESS CONSOLE</p>
        <h1>Application received</h1>
        <span>{submitted}</span>
        <Link href="/console/login">Back to sign in</Link>
      </section>
    </main>;
  }

  return <main className="console-auth-page">
    <form className="console-auth-card" onSubmit={submit}>
      <img src="/logo.svg" alt="UMaTeXPRESS" />
      <p>UMATEXPRESS CONSOLE</p>
      <h1>Organise your coach</h1>
      <span>Apply to publish trips on vacationRide. An administrator reviews every application before an account is activated.</span>
      {FIELDS.map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            type={field.type}
            autoComplete={field.autoComplete}
            required={field.required}
            value={form[field.key]}
            onChange={update(field.key)}
          />
        </label>
      ))}
      <label>
        Password
        <input
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={update("password")}
        />
      </label>
      <small>Use at least 10 characters with an uppercase letter, a lowercase letter, a number and a symbol.</small>
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={submitting}><Store size={17} />{submitting ? "Submitting…" : "Apply to organise"}</button>
      <Link href="/console/login">Already approved? Sign in</Link>
    </form>
  </main>;
}
