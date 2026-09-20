"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { consoleGroupsForRole } from "@/components/admin/console-services";
import { ConsoleBriefStrip } from "@/components/console/ConsoleBriefStrip";
import { ConsoleShell } from "@/components/console/ConsoleShell";

const ROLE_COPY: Record<string, { title: string; blurb: string }> = {
  ADMIN: { title: "One campus. One console.", blurb: "Every UMaTeXPRESS service, one sign-in." },
  MODERATOR: { title: "Review and keep it fair.", blurb: "Trips, organizer applications and hostel listings that need a decision." },
  ORGANIZER: { title: "Your trips, your way.", blurb: "Publish coaches, watch bookings and reach your passengers." },
  LANDLORD: { title: "Your hostels, your way.", blurb: "Build your properties and bed-spaces for students." },
  DRIVER: { title: "Ready for the next queue.", blurb: "Your vehicle, your queue and your passengers." },
};

export default function ConsoleHome() {
  return <ConsoleSessionGate label="console access">{(session) => <ConsoleHomeWorkspace session={session} />}</ConsoleSessionGate>;
}

function ConsoleHomeWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const copy = ROLE_COPY[session.account.role] || ROLE_COPY.ADMIN;
  const groups = consoleGroupsForRole(session.account.role);
  return <ConsoleShell
    session={session}
    service="home"
    label={`WELCOME, ${session.account.name || session.account.email}`}
    title={copy.title}
    blurb={copy.blurb}
  >
    <ConsoleBriefStrip />
    {groups.map((group) => <section className="console-group" key={group.group} aria-label={group.group}>
      <h2 className="console-group-heading">{group.group}</h2>
      <div className="console-group-grid">
        {group.services.map((service) => {
          const Icon = service.icon;
          return <article className={`console-card console-card-${service.accent}`} key={service.id}>
            <span className="console-card-icon"><Icon size={22}/></span>
            <p className="console-card-label">{service.label}</p>
            <h2>{service.title}</h2>
            <p className="console-card-detail">{service.detail}</p>
            <div className="console-card-tags">{service.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            {service.href
              ? <Link className="console-card-action" href={service.href}>{service.action}<ArrowRight size={17}/></Link>
              : <span className="console-card-soon">Coming soon</span>}
          </article>;
        })}
      </div>
    </section>)}

    <footer className="console-footer">
      <span>UMaTeXPRESS Console</span>
      <span>Signed in as {session.account.role.toLowerCase()}</span>
    </footer>
  </ConsoleShell>;
}
