"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, LogOut, ShieldCheck } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { consoleServicesForRole } from "@/components/admin/console-services";

const ROLE_COPY: Record<string, { label: string; title: string; blurb: string }> = {
  ADMIN: { label: "Administrator", title: "One campus. One console.", blurb: "Every UMaTeXPRESS service, one sign-in." },
  MODERATOR: { label: "Moderator", title: "Review and keep it fair.", blurb: "Trips, organizer applications and hostel listings that need a decision." },
  ORGANIZER: { label: "Organizer", title: "Your trips, your way.", blurb: "Publish coaches, watch bookings and reach your passengers." },
  DRIVER: { label: "Driver", title: "Ready for the next queue.", blurb: "Your vehicle, your queue and your passengers." },
};

export default function ConsoleHome() {
  return <ConsoleSessionGate label="console access">{(session) => <ConsoleWorkspace session={session} />}</ConsoleSessionGate>;
}

function ConsoleWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const copy = ROLE_COPY[session.account.role] || ROLE_COPY.ADMIN;
  const services = consoleServicesForRole(session.account.role);

  async function signOut() {
    setSigningOut(true); setSignOutError("");
    try {
      const response = await fetch("/api/console/session", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Sign-out failed.");
      router.replace("/console/login");
    } catch {
      setSignOutError("Could not sign out. Check your connection and try again.");
      setSigningOut(false);
    }
  }

  return <main className="console-page">
    <header className="console-header">
      <Link href="/console" className="console-brand"><img src="/logo.svg" width="40" height="40" alt=""/><span>UMaTe<em>XPRESS</em><small>Console</small></span></Link>
      <div className="console-account">
        <span className="console-role-chip"><ShieldCheck size={15}/>{copy.label}</span>
        <span className="console-account-email">{session.account.email}</span>
        <button onClick={signOut} disabled={signingOut}><LogOut size={16}/>{signingOut ? "Signing out…" : "Sign out"}</button>
      </div>
    </header>

    <section className="console-hero">
      <p>WELCOME, {session.account.name || session.account.email}</p>
      <h1>{copy.title}</h1>
      <span>{copy.blurb}</span>
    </section>

    {signOutError && <p className="console-alert" role="alert">{signOutError}</p>}

    <section className="console-services" aria-label="Console services">
      {services.map((service) => {
        const Icon = service.icon;
        const href = service.id === "security" ? "/console/change-password" : service.href;
        return <article className={`console-card console-card-${service.accent}`} key={service.id}>
          <span className="console-card-icon"><Icon size={22}/></span>
          <p className="console-card-label">{service.label}</p>
          <h2>{service.title}</h2>
          <p className="console-card-detail">{service.detail}</p>
          <div className="console-card-tags">{service.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          {href
            ? <Link className="console-card-action" href={href}>{service.action}<ArrowRight size={17}/></Link>
            : <span className="console-card-soon">Coming soon</span>}
        </article>;
      })}
    </section>

    <footer className="console-footer">
      <span>UMaTeXPRESS Console</span>
      <span>Signed in as {session.account.role.toLowerCase()}</span>
    </footer>
  </main>;
}
