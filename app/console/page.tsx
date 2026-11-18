"use client";

import Link from "next/link";
import { ArrowRight, GearSix, LockKey, SquaresFour, UserCircle, UsersThree } from "@/components/ui/MaterialIcon";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { CONSOLE_GROUP_ORDER, consoleServiceNavForRole, consoleServicesForRole, type ConsoleService } from "@/components/admin/console-services";
import { ConsoleBriefStrip } from "@/components/console/ConsoleBriefStrip";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import "./home.css";

const ROLE_COPY: Record<string, { label: string; blurb: string; featured: string; focus: string }> = {
  ADMIN: { label: "ADMINISTRATOR WORKSPACE", blurb: "See what needs attention, then move directly into the right service.", featured: "campus", focus: "Keep routes, drivers and queues ready for the next ride." },
  MODERATOR: { label: "MODERATOR WORKSPACE", blurb: "Review decisions and resolve issues across your assigned services.", featured: "organizers", focus: "Work through applications and record clear decisions." },
  ORGANIZER: { label: "ORGANIZER WORKSPACE", blurb: "Your trips, passengers and earnings in one place.", featured: "organizer", focus: "Plan the next departure and stay close to your passengers." },
  LANDLORD: { label: "LANDLORD WORKSPACE", blurb: "Manage your properties and the students who live in them.", featured: "hostels", focus: "Keep listings, rooms and resident requests current." },
  DRIVER: { label: "DRIVER WORKSPACE", blurb: "Your ride and boarding queue are ready when you are.", featured: "driver", focus: "Check your current ride and guide the next boarding." },
  VENDOR: { label: "VENDOR WORKSPACE", blurb: "See food requests and keep each collection moving.", featured: "food", focus: "Review incoming orders and update preparation." },
  CINEMA: { label: "CINEMA PARTNER WORKSPACE", blurb: "Manage your screenings and keep the audience experience on track.", featured: "cinema", focus: "Review your watch rooms, events and audience requests." },
};
const DEFAULT_COPY = { label: "YOUR CONSOLE", blurb: "Open the services available to your account.", featured: "account", focus: "Review your account and security settings." };

const ACCOUNT_IDS = new Set(["account", "security"]);

export default function ConsoleHome() {
  return <ConsoleSessionGate label="console access">{(session) => <ConsoleHomeWorkspace session={session} />}</ConsoleSessionGate>;
}

function ConsoleHomeWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const role = session.account.role;
  const copy = ROLE_COPY[role] || DEFAULT_COPY;
  const services = consoleServicesForRole(role, session.account.delegateServices);
  const isFullAdmin = role === "ADMIN" && session.account.delegateServices === undefined;
  const utilityIds = new Set(isFullAdmin ? ["account", "security", "delegates", "settings"] : ["account", "security"]);
  const featured = services.find(service => service.id === copy.featured) || services.find(service => !ACCOUNT_IDS.has(service.id)) || services[0];
  const FeaturedIcon = featured?.icon;
  const secondary = services.filter(service => service.id !== featured?.id && !utilityIds.has(service.id)).slice(0, 5);
  const highlightedIds = new Set([featured?.id, ...secondary.map(service => service.id)]);
  const remaining = services.filter(service => !highlightedIds.has(service.id) && !utilityIds.has(service.id));
  const firstName = session.account.name?.trim().split(/\s+/)[0] || "there";

  return <ConsoleShell
    session={session}
    service="home"
    label={session.account.delegateServices !== undefined ? "ADMIN DELEGATE WORKSPACE" : copy.label}
    title={`Welcome back, ${firstName}`}
    blurb={copy.blurb}
  >
    <div className="console-home-board">
      {session.account.delegateServices === undefined && <ConsoleBriefStrip />}

      {featured && <div className="console-home-main-grid">
        <section className={`console-home-feature console-home-feature-${featured.accent}`} aria-labelledby="console-home-feature-title">
          <div className="console-home-feature-top">
            <span className="console-home-eyebrow">START HERE</span>
            <span className="console-home-feature-icon">{FeaturedIcon && <FeaturedIcon size={26} aria-hidden />}</span>
          </div>
          <div>
            <p className="console-home-feature-label">{featured.group}</p>
            <h2 id="console-home-feature-title">{featured.title}</h2>
            <p className="console-home-feature-copy">{featured.id === copy.featured ? copy.focus : featured.detail}</p>
          </div>
          <div className="console-home-feature-bottom">
            <Link href={featured.href}>{featured.action}<ArrowRight size={18} aria-hidden /></Link>
            {consoleServiceNavForRole(featured, role).length > 1 && <div className="console-home-feature-subnav" aria-label={`${featured.title} pages`}>
              {consoleServiceNavForRole(featured, role).slice(1, 3).map(item => <Link key={item.href} href={item.href}>{item.label}</Link>)}
            </div>}
          </div>
        </section>

        <section className="console-home-workspaces" aria-labelledby="console-home-workspaces-title">
          <div className="console-home-section-heading">
            <div><span className="console-home-eyebrow">YOUR ACCESS</span><h2 id="console-home-workspaces-title">Workspaces</h2></div>
            <span>{services.length} available</span>
          </div>
          {secondary.length ? <div className="console-home-workspace-list">
            {secondary.map(service => <WorkspaceLink key={service.id} service={service} />)}
          </div> : <div className="console-home-workspace-empty">
            <SquaresFour size={22} aria-hidden />
            <p>Your main workspace is ready. Account and security tools are below.</p>
          </div>}
        </section>
      </div>}

      {remaining.length > 0 && <details className="console-home-more">
        <summary><span><SquaresFour size={20} aria-hidden /><strong>More in your console</strong><small>{remaining.length} {remaining.length === 1 ? "workspace" : "workspaces"}</small></span><span className="console-home-more-indicator" aria-hidden>+</span></summary>
        <div className="console-home-more-groups">
          {CONSOLE_GROUP_ORDER.map(group => {
            const items = remaining.filter(service => service.group === group);
            if (!items.length) return null;
            return <section key={group} aria-label={group}>
              <h3>{group}</h3>
              <div>{items.map(service => <WorkspaceLink key={service.id} service={service} />)}</div>
            </section>;
          })}
        </div>
      </details>}

      <nav className="console-home-utilities" aria-label="Account and console settings">
        <Link href="/console/account"><UserCircle size={18} aria-hidden /> My account</Link>
        <Link href="/console/change-password"><LockKey size={18} aria-hidden /> Security</Link>
        {isFullAdmin && <>
          <Link href="/console/delegates"><UsersThree size={18} aria-hidden /> Team access</Link>
          <Link href="/console/settings"><GearSix size={18} aria-hidden /> Platform settings</Link>
        </>}
      </nav>
    </div>
  </ConsoleShell>;
}

function WorkspaceLink({ service }: { service: ConsoleService }) {
  const Icon = service.icon;
  return <Link className="console-home-workspace-link" href={service.href}>
    <span className={`console-home-workspace-icon is-${service.accent}`}><Icon size={20} aria-hidden /></span>
    <span className="console-home-workspace-copy"><strong>{service.title}</strong><small>{service.description}</small></span>
    <ArrowRight size={17} aria-hidden />
  </Link>;
}
