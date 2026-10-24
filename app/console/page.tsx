"use client";

import Link from "next/link";
import { ArrowRight, GearSix, UserCircle, UsersThree } from "@/components/ui/MaterialIcon";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { consoleGroupsForRole } from "@/components/admin/console-services";
import { ConsoleBriefStrip } from "@/components/console/ConsoleBriefStrip";
import { ConsoleShell } from "@/components/console/ConsoleShell";

const ROLE_COPY: Record<string, { title: string; blurb: string }> = {
  ADMIN: { title: "One campus. One console.", blurb: "Every UMaTeXPRESS service that runs the platform, one sign-in." },
  MODERATOR: { title: "Review and keep it fair.", blurb: "Trips, organizer applications and hostel listings that need a decision." },
  ORGANIZER: { title: "Your trips, your way.", blurb: "Publish coaches, watch bookings and reach your passengers." },
  LANDLORD: { title: "Your hostels, your way.", blurb: "Build your properties and bed-spaces for students." },
  DRIVER: { title: "Ready for the next queue.", blurb: "Your vehicle, your queue and your passengers." },
  VENDOR: { title: "Prepare every pickup with confidence.", blurb: "Accept requests, update preparation and record each collection." },
};

export default function ConsoleHome() {
  return <ConsoleSessionGate label="console access">{(session) => <ConsoleHomeWorkspace session={session} />}</ConsoleSessionGate>;
}

function ConsoleHomeWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const copy = ROLE_COPY[session.account.role] || ROLE_COPY.ADMIN;
  const groups = consoleGroupsForRole(session.account.role, session.account.delegateServices);
  return <ConsoleShell
    session={session}
    service="home"
    label={`WELCOME, ${session.account.name || session.account.email}`}
    title={copy.title}
    blurb={copy.blurb}
  >
    {session.account.role === "ADMIN" && <section className="console-home-intro" aria-label="Admin workspace">
      <div><span>ADMIN WORKSPACE</span><h2>Operations at a glance</h2><p>Choose a service to manage, or open the controls you use most often.</p></div>
      <div className="console-home-shortcuts"><Link href="/console/account"><UserCircle size={18}/> My account</Link>{session.account.delegateServices === undefined && <><Link href="/console/delegates"><UsersThree size={18}/> Team access</Link><Link href="/console/settings"><GearSix size={18}/> Platform settings</Link></>}</div>
    </section>}
    {session.account.delegateServices === undefined && <ConsoleBriefStrip />}
    <div className={`console-home-directory${session.account.role === "ADMIN" ? " is-admin" : ""}`}>
    {groups.map((group) => <section className="console-group" key={group.group} aria-label={group.group}>
      <div className="console-group-title"><h2 className="console-group-heading">{group.group}</h2><span>{group.services.length} {group.services.length === 1 ? "service" : "services"}</span></div>
      <div className="console-group-grid">
        {group.services.map((service) => {
          const Icon = service.icon;
          return <Link className={`console-card console-card-${service.accent}`} href={service.href} key={service.id}>
            <span className="console-card-icon"><Icon size={22}/></span>
            <p className="console-card-label">{service.label}</p>
            <h2>{service.title}</h2>
            <p className="console-card-detail">{service.detail}</p>
            <div className="console-card-tags">{service.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <span className="console-card-action">{service.action}<ArrowRight size={17}/></span>
          </Link>;
        })}
      </div>
    </section>)}
    </div>

    <footer className="console-footer">
      <span>UMaTeXPRESS Console</span>
      <span>Signed in as {session.account.delegateServices !== undefined ? "admin delegate" : session.account.role.toLowerCase()}</span>
    </footer>
  </ConsoleShell>;
}
