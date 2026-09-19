"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Send } from "lucide-react";
import { consoleApplicationById, type ConsoleApplication } from "@/lib/console-applications";

function ApplicationNotice({ title, message }: { title: string; message: string }) {
  return <main className="console-auth-page">
    <section className="console-auth-card">
      <img src="/logo.svg" alt="UMaTeXPRESS" />
      <p>UMATEXPRESS CONSOLE</p>
      <h1>{title}</h1>
      <span>{message}</span>
      <Link href="/console/register">See every service</Link>
      <Link href="/console/login">Back to sign in</Link>
    </section>
  </main>;
}

/**
 * One form for every application programme. The fields, the copy and the
 * endpoint come from the registry, so opening a new service to applications is
 * a registry entry plus the server handler — never a new page.
 */
function ApplicationForm({ application }: { application: ConsoleApplication }) {
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(application.fields.map((field) => [field.key, ""])));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState("");

  const update = (key: string) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(application.endpoint, {
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
      <h1>{application.title}</h1>
      <span>{application.detail}</span>
      {application.fields.map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            type={field.type}
            autoComplete={field.autoComplete}
            required={field.required}
            value={form[field.key] || ""}
            onChange={update(field.key)}
          />
          {field.hint && <small className="console-field-hint">{field.hint}</small>}
        </label>
      ))}
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={submitting}><Send size={17} />{submitting ? "Submitting…" : application.applyLabel}</button>
      <Link href="/console/register">Apply for a different service</Link>
      <Link href="/console/login">Already approved? Sign in</Link>
    </form>
  </main>;
}

export default function ConsoleApplicationPage() {
  const params = useParams<{ programme: string }>();
  const id = (Array.isArray(params?.programme) ? params.programme[0] : params?.programme) || "";
  const application = consoleApplicationById(id);

  if (!application) {
    return <ApplicationNotice title="Application not found" message="That service does not take applications from this page." />;
  }
  if (application.status !== "OPEN") {
    return <ApplicationNotice title={`${application.short} is not open yet`} message={application.detail} />;
  }
  return <ApplicationForm application={application} />;
}
