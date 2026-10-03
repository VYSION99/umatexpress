"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ArrowSquareOut, CaretDown, GearSix, House, LockKey, MagnifyingGlass, ShieldCheck, SignOut, SquaresFour, UserCircle, X } from "@phosphor-icons/react";
import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { consoleGroupsForRole, consoleServicesForRole, consoleServiceById, consoleServiceNavForRole } from "@/components/admin/console-services";
import { ConsoleAssistant } from "@/components/console/ConsoleAssistant";
import { ConsoleNotifications } from "@/components/console/ConsoleNotifications";
import "@/components/launcher/launcher.css";
import "@/components/admin/console.css";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Administrator",
  MODERATOR: "Moderator",
  ORGANIZER: "Organizer",
  LANDLORD: "Landlord",
  DRIVER: "Driver",
};

/**
 * The platform console shell: one frame for every service, the way a cloud
 * console frames every product. The left rail is the service directory for the
 * signed-in role, the top bar carries the breadcrumb, the service finder and
 * the account. A page supplies its own hero and body and nothing else.
 *
 * `service` names the service the page belongs to ("home" for the console
 * home). The shell never decides what a role may do — the server does, on every
 * request — it only decides what to show.
 */
export function ConsoleShell({
  session,
  service,
  label,
  title,
  blurb,
  actions,
  children,
}: {
  session: ConsoleSessionInfo;
  service: string;
  label: string;
  title: string;
  blurb?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const roleLabel = session.account.delegateServices !== undefined ? "Admin delegate" : ROLE_LABEL[session.account.role] || session.account.role;
  const groups = consoleGroupsForRole(session.account.role, session.account.delegateServices);
  const current = consoleServiceById(service);
  const available = consoleServicesForRole(session.account.role, session.account.delegateServices);
  const [panel, setPanel] = useState(false);
  const [query, setQuery] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panel) dialog.current?.showModal();
    else dialog.current?.close();
  }, [panel]);
  useEffect(() => {
    if (!accountOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!accountMenu.current?.contains(event.target as Node)) setAccountOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setAccountOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [accountOpen]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? available.filter((item) => `${item.title} ${item.detail} ${item.tags.join(" ")}`.toLowerCase().includes(needle))
    : available;

  const initials = session.account.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join("") || "U";
  const roleSettings = session.account.role === "LANDLORD" ? { href: "/console/hostels/onboarding", label: "Hostel setup" }
    : session.account.role === "ORGANIZER" ? { href: "/console/profile", label: "Business profile" }
    : session.account.role === "ADMIN" && (session.account.delegateServices === undefined || session.account.delegateServices.includes("settings")) ? { href: "/console/settings", label: "Platform settings" }
    : null;

  async function signOut() {
    setSigningOut(true);
    setSignOutError("");
    try {
      const response = await fetch("/api/console/session", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Sign-out failed.");
      router.replace("/console/login");
    } catch {
      setSignOutError("Could not sign out. Check your connection and try again.");
      setSigningOut(false);
    }
  }

  return <div className="launcher console-launcher">
    <a href="#console-main" className="launch-skip">Skip to the console</a>
    <aside className="console-sidebar">
      <Link href="/console" className="launch-brand">
        <img src="/logo-mark.png" width="44" height="44" alt=""/>
        <span>UMaTe<span>XPRESS</span><small>Console</small></span>
      </Link>
      <span className="console-sidebar-label">CONSOLE</span>
      <nav aria-label="Console home">
        <Link href="/console" aria-current={service === "home" ? "page" : undefined}><House size={19}/> Home</Link>
        <button type="button" onClick={() => setPanel(true)}><SquaresFour size={19}/> All services</button>
      </nav>
      {groups.map((group) => <Fragment key={group.group}>
        <span className="console-sidebar-label">{group.group.toUpperCase()}</span>
        <nav aria-label={group.group}>
          {group.services.map((item) => {
            const Icon = item.icon;
            const active = item.id === service;
            const subnav = consoleServiceNavForRole(item, session.account.role);
            return <div className="console-service" key={item.id}>
              {item.href
                ? <Link href={item.href} aria-current={active ? "page" : undefined}><Icon size={19}/>{item.title}</Link>
                : <span className="console-service-soon"><Icon size={19}/>{item.title}<small>Soon</small></span>}
              {active && subnav.length > 1 && <div className="console-subnav">
                {subnav.map((entry) => <Link key={entry.href} href={entry.href} aria-current={pathname === entry.href ? "page" : undefined}>{entry.label}</Link>)}
              </div>}
            </div>;
          })}
        </nav>
      </Fragment>)}
      <div className="console-sidebar-bottom">
        <Link href="/"><ArrowSquareOut size={17}/> Student homepage</Link>
        <span><ShieldCheck size={18}/> {roleLabel} workspace</span>
      </div>
    </aside>

    <div className="console-workspace">
      <header className="console-topbar">
        <Link href="/console" className="console-mobile-brand" aria-label="Console home"><img src="/logo-mark.png" width="40" height="40" alt=""/><span>Console</span></Link>
        <span className="console-breadcrumb">Console <span>/</span> {current ? current.title : "Home"}</span>
        <form className="launch-search" onSubmit={(event) => { event.preventDefault(); setPanel(true); }}>
          <MagnifyingGlass size={18}/>
          <input aria-label="Find a service" placeholder="Find a service…" value={query} onChange={(event) => setQuery(event.target.value)}/>
          <button aria-label="Search services"><ArrowRight size={17}/></button>
        </form>
        {actions && <div className="console-topbar-actions">{actions}</div>}
        <ConsoleNotifications />
        <div className="console-profile-dropdown" ref={accountMenu}>
          <button type="button" className="console-profile-trigger" aria-label={`Account menu for ${session.account.name}`} aria-expanded={accountOpen} aria-controls="console-account-menu" onClick={() => setAccountOpen(value => !value)}>
            <span className="console-profile-trigger-avatar" aria-hidden="true">{initials}</span>
            <span className="console-profile-trigger-copy"><strong>{session.account.name}</strong><small>{roleLabel}</small></span>
            <CaretDown size={15} aria-hidden="true"/>
          </button>
          {accountOpen && <div id="console-account-menu" className="console-profile-popover">
            <div className="console-profile-popover-head"><span className="console-profile-trigger-avatar" aria-hidden="true">{initials}</span><div><strong>{session.account.name}</strong><small>{session.account.email}</small></div></div>
            <nav aria-label="Account actions">
              <Link href="/console/account#profile" onClick={() => setAccountOpen(false)}><UserCircle size={18}/> My profile</Link>
              <Link href="/console/account#settings" onClick={() => setAccountOpen(false)}><GearSix size={18}/> Account settings</Link>
              <Link href="/console/change-password" onClick={() => setAccountOpen(false)}><LockKey size={18}/> Change password</Link>
              {roleSettings && <Link href={roleSettings.href} onClick={() => setAccountOpen(false)}><ShieldCheck size={18}/> {roleSettings.label}</Link>}
            </nav>
            <button type="button" className="console-profile-signout" onClick={() => void signOut()} disabled={signingOut}><SignOut size={18}/>{signingOut ? "Signing out…" : "Sign out"}</button>
          </div>}
        </div>
      </header>

      <main id="console-main" className="launch-main">
        <section className="console-hero">
          <p>{label}</p>
          <h1>{title}</h1>
          {blurb && <span>{blurb}</span>}
        </section>
        {signOutError && <p className="console-alert" role="alert">{signOutError}</p>}
        {service === "home" || service === "security" || service === "account" || session.account.delegateServices === undefined || session.account.delegateServices.includes(service)
          ? children
          : <p className="console-alert" role="alert">This service is not assigned to your delegate account. Ask an administrator to update your access.</p>}
      </main>
    </div>

    <nav className="launch-mobile-nav" aria-label="Console navigation">
      <Link href="/console" aria-current={service === "home" ? "page" : undefined}><House size={21}/>Home</Link>
      <button type="button" onClick={() => setPanel(true)}><SquaresFour size={21}/>Services</button>
      <Link href="/console/change-password" aria-current={pathname === "/console/change-password" ? "page" : undefined}><LockKey size={21}/>Security</Link>
      <Link href="/console/account" aria-current={pathname === "/console/account" ? "page" : undefined}><UserCircle size={21}/>Account</Link>
    </nav>

    <dialog ref={dialog} className="launch-dialog" aria-labelledby="console-switcher-title" onCancel={() => setPanel(false)} onClick={(event) => { if (event.target === event.currentTarget) setPanel(false); }}>
      <div className="launch-dialog-inner">
        <div className="launch-dialog-heading">
          <h2 id="console-switcher-title">Services</h2>
          <button className="launch-icon-button" aria-label="Close" onClick={() => setPanel(false)}><X size={21}/></button>
        </div>
        <label className="launch-search">
          <MagnifyingGlass size={18}/>
          <input autoFocus aria-label="Filter services" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rides, trips, payouts…"/>
        </label>
        <div className="launch-directory">
          {matches.map((item) => {
            const Icon = item.icon;
            return <article key={item.id}>
              <Icon size={23}/>
              <div>
                <h3>{item.title}<small className="console-directory-group">{item.group}</small></h3>
                <p>{item.href ? item.detail : "Coming soon"}</p>
                {item.href && <Link href={item.href}>{item.action} →</Link>}
              </div>
            </article>;
          })}
          {!matches.length && <p role="status">No matching services. Try “rides”, “trips”, or “payouts”.</p>}
        </div>
      </div>
    </dialog>
    {session.account.delegateServices === undefined && <ConsoleAssistant session={session} service={service} />}
  </div>;
}
