"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowDown, ArrowRight, ArrowSquareOut, ArrowUp, Bell, Bus, Car, Compass, House, MagnifyingGlass, MapPin, PushPin, Sliders, SquaresFour, Ticket, User, X } from "@/components/ui/MaterialIcon";
import { defaultPreferences, homepageServices, services, type LauncherPreference, type OpenService, type Service } from "./services";
import { useLauncherLayout } from "./useLauncherLayout";
import { ProfilePanel } from "./ProfilePanel";
import { NotificationFeed } from "./NotificationFeed";
import { useNotifications } from "@/components/account/useNotifications";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import { entrance } from "@/components/ui/motion";
import { SheetHandle } from "@/components/ui/SheetHandle";
import "./launcher.css";
import "./home.css";

type Panel = "services" | "customise" | "profile" | "tickets" | "notifications" | "support" | null;

/** Partner services run on their own origin. */
type PartnerService = Extract<Service, { external: true }>;

function isExternal(service: Service): service is PartnerService {
  return "external" in service && service.external === true;
}

function ServiceCard({ service, pinned }: { service: OpenService; pinned: boolean }) {
  const Icon = service.icon;
  const external = isExternal(service);
  // The artwork is decorative because the heading names the service.
  const art = "art" in service ? service.art : null;
  const logo = "logo" in service ? service.logo : null;
  const cardClass = `home-card is-${service.accent}${logo ? " is-partner" : ""}`;
  const content = <>
    {logo
      ? <div className="home-card-art home-card-art--brand"><img src={logo} alt="" width={306} height={122} loading="lazy" decoding="async" /></div>
      : art
      ? <div className="home-card-art"><img src={art} alt="" width={840} height={394} loading="lazy" decoding="async" /></div>
      : <span className="home-card-icon"><Icon size={22} aria-hidden /></span>}
    <h3>{service.title}{pinned && <PushPin size={13} aria-label="Pinned" />}</h3>
    <p>{service.description}</p>
    <span className="home-card-link">{service.action}{external ? <ArrowSquareOut size={15} aria-hidden /> : <ArrowRight size={15} aria-hidden />}</span>
  </>;
  return <Link
    className={cardClass}
    href={service.destination}
    aria-label={`${service.title}: ${service.action}${external ? " (opens in a new tab)" : ""}`}
    {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
  >{content}</Link>;
}

export default function CampusLauncher() {
  const { preferences, ready, save: saveLayout, error } = useLauncherLayout();
  // The account is the source of truth once signed in; guests stay "Guest".
  const { account } = useStudentAccount();
  // Unread count for the bell; the panel reads the same cached list.
  const { unread } = useNotifications();
  const greeting = (account?.name || "").trim().split(/\s+/)[0] || "";
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (panel) dialog.current?.showModal(); else dialog.current?.close(); }, [panel]);
  function save(next: LauncherPreference[]) {
    setNotice(saveLayout(next) ? "Layout saved on this device." : "Your layout is updated for this visit. Browser storage is unavailable.");
  }
  function toggle(id: string, field: "hidden" | "pinned") { save(preferences.map(item => item.id === id ? { ...item, [field]: !item[field] } : item)); }
  function move(id: string, offset: number) {
    const next = [...preferences]; const index = next.findIndex(item => item.id === id); const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; save(next);
  }
  // The sheet and the homepage cards share one live-service projection, so a
  // hide/show toggle in the sheet is reflected on the page.
  // The panel body remounts on every switch, so each sheet animated in.
  const reducedMotion = useReducedMotion();
  const openServices = services.filter(service => service.available);
  const homepage = homepageServices(preferences);
  const pinned = new Set(preferences.filter(item => item.pinned).map(item => item.id));
  const matches = openServices.filter(service => `${service.title} ${service.description} ${service.detail} ${service.category}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <div className="launcher home">
    <a href="#home-main" className="launch-skip">Skip to services</a>
    <header className="home-bar">
      <Link href="/" className="home-brand"><img className="home-mark" src="/logo-mark.png" width="40" height="40" alt="" /><span><span className="home-wordmark">UMaTe<em>X</em>PRESS</span><p className="home-tagline">Your campus companion</p></span></Link>
      <nav className="home-nav-desktop" aria-label="Campus services"><a href="#services">Explore</a><Link href="/campus"><Car size={16} aria-hidden />campusRide</Link><Link href="/vacation"><Bus size={16} aria-hidden />vacationRide</Link></nav>
      <div className="home-bar-actions">
        <button className="home-icon-button" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} onClick={() => setPanel("notifications")}><Bell size={20} aria-hidden />{unread > 0 && <span className="home-dot" aria-hidden />}</button>
        <button className="home-guest" onClick={() => setPanel("profile")} aria-label="Your profile"><User size={18} aria-hidden /><span>{greeting || "Guest"}</span></button>
      </div>
    </header>
    <main id="home-main" className="home-main">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
        <span className="home-pill"><MapPin size={13} aria-hidden /> UMaT, Tarkwa</span>
        <h1 id="home-title">Campus life.<br /><em>A little easier.</em></h1>
        <p>From your first lecture to your journey home. Find a ride, settle into a room, and make more of life at UMaT.</p>
        <div className="home-hero-actions"><a className="home-cta" href="#services">Explore services<ArrowRight size={18} aria-hidden /></a><button className="home-secondary" onClick={() => setPanel("profile")}><User size={17} aria-hidden />{greeting ? "Your account" : "Your student account"}</button></div>
        <div className="home-hero-caption"><span />Built around your campus. Ready for your day.</div>
        </div>
        <aside className="home-day" aria-label="Your campus companion">
          <div className="home-day-heading"><span>THE CAMPUS EDIT</span><Compass size={22} aria-hidden /></div>
          <h2>One place.<br />More possibilities.</h2>
          <p>The everyday essentials, all within reach.</p>
          <div className="home-day-list">
            <div><span><Car size={22} aria-hidden /></span><div><strong>Make your next move</strong><small>Rides around campus and beyond</small></div><ArrowRight size={17} aria-hidden /></div>
            <div><span><House size={22} aria-hidden /></span><div><strong>Find a place to belong</strong><small>Explore your next student home</small></div><ArrowRight size={17} aria-hidden /></div>
            <div><span><SquaresFour size={22} aria-hidden /></span><div><strong>Make time for more</strong><small>Watch, collaborate and discover</small></div><ArrowRight size={17} aria-hidden /></div>
          </div>
          <div className="home-day-footer"><MapPin size={14} aria-hidden /> UMaT, Tarkwa <span>Made for students</span></div>
        </aside>
      </section>
      <section id="services" className="home-section" aria-labelledby="home-services-title" aria-busy={!ready}>
        <div className="home-section-head"><div><p className="home-kicker">YOUR EVERYDAY ESSENTIALS</p><h2 id="home-services-title">What’s the plan today?</h2></div><button onClick={() => setPanel("services")}>See all<ArrowRight size={14} aria-hidden /></button></div>
        {homepage.length
          ? <div className="home-rail">{homepage.map(service => <ServiceCard key={service.id} pinned={pinned.has(service.id)} service={service} />)}</div>
          : <div className="launch-empty"><Compass size={28} aria-hidden /><h2>A little space for your favourites.</h2><p>Restore a service from Open services.</p><button onClick={() => setPanel("services")}>Discover services</button></div>}
      </section>
      <section className="home-section" aria-labelledby="home-soon-title">
        <div className="home-section-head"><h2 id="home-soon-title">On the way</h2><span className="home-section-note">Not live yet</span></div>
        <div className="home-soon">{services.filter(service => !service.available).map(service => { const Icon = service.icon; return <div key={service.id}><Icon size={19} aria-hidden /><strong>{service.title}</strong><span>{service.detail}</span></div>; })}</div>
      </section>
      <section className="home-note"><Compass size={19} aria-hidden /><span>Questions about a ride or booking?</span><button onClick={() => setPanel("support")}>Need a hand?</button></section>
      {/* Client footer only. The driver portal and the management console live on
          their own routes and are not advertised from the student homepage. */}
      <footer className="home-footer"><span><strong>UMaTeXPRESS</strong> · Made for campus life.</span><button onClick={() => setPanel("support")}>Help</button></footer>
    </main>
    <nav className="home-nav" aria-label="Home sections">
      <a href="#home-main" aria-current="page"><House size={21} aria-hidden />Home</a>
      <button onClick={() => setPanel("services")}><SquaresFour size={21} aria-hidden />Services</button>
      <button onClick={() => setPanel("tickets")}><Ticket size={21} aria-hidden />Tickets</button>
      <button onClick={() => setPanel("profile")}><User size={21} aria-hidden />Profile</button>
    </nav>
    <dialog ref={dialog} className="launch-dialog" onCancel={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null); }} aria-labelledby="launch-dialog-title">
      <SheetHandle onDismiss={() => setPanel(null)} />
      <motion.div className="launch-dialog-inner" key={panel ?? "closed"} {...entrance(reducedMotion)}><div className="launch-dialog-heading"><h2 id="launch-dialog-title">{panel === "services" ? "Open services" : panel === "customise" ? "Make it yours" : panel === "profile" ? "Your profile" : panel === "tickets" ? "Your tickets" : panel === "notifications" ? "Notifications" : "Here to help"}</h2><button className="home-icon-button" aria-label="Close" onClick={() => setPanel(null)}><X size={20} aria-hidden /></button></div>
      {panel === "services" && <><label className="launch-search"><MagnifyingGlass size={18} aria-hidden /><input aria-label="Filter open services" placeholder="Search rides, hostels, cinema…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <p className="launch-directory-note">{homepage.length} of {openServices.length} open services on your homepage.</p>
      <div className="launch-directory">{matches.map(service => { const item = preferences.find(row => row.id === service.id)!; const Icon = service.icon; return <article key={service.id}><Icon size={24} aria-hidden /><div><h3>{service.title}</h3><p>{service.description}</p>{service.destination && <Link
  href={service.destination}
  aria-label={isExternal(service) ? `${service.action}: ${service.title} (opens in a new tab)` : undefined}
  {...(isExternal(service) ? { target: "_blank", rel: "noreferrer noopener" } : {})}
>{service.action} →</Link>}</div><button aria-pressed={!item.hidden} aria-label={`${item.hidden ? "Show" : "Hide"} ${service.title} on the homepage`} onClick={() => toggle(service.id, "hidden")}>{item.hidden ? "Show" : "Hide"}</button></article>; })}{!matches.length && <p role="status">No open services match “{query}”. Try “ride” or clear your search.</p>}</div>
      <button className="launch-reset" onClick={() => setPanel("customise")}><Sliders size={16} aria-hidden /> Customise layout</button></>}
      {panel === "customise" && <><p>Pin favourites to the top, hide widgets, or move them with the arrows. Your choices stay on this device.</p><div className="launch-customise">{preferences.map((item, index) => <article key={item.id}><strong>{services.find(service => service.id === item.id)!.title}</strong><div><button aria-label={`Pin ${item.id}`} aria-pressed={item.pinned} onClick={() => toggle(item.id, "pinned")}><PushPin size={17} aria-hidden /></button><button aria-label={`Move ${item.id} earlier`} disabled={index === 0} onClick={() => move(item.id, -1)}><ArrowUp size={17} aria-hidden /></button><button aria-label={`Move ${item.id} later`} disabled={index === preferences.length - 1} onClick={() => move(item.id, 1)}><ArrowDown size={17} aria-hidden /></button><button aria-pressed={!item.hidden} onClick={() => toggle(item.id, "hidden")}>{item.hidden ? "Show" : "Hide"}</button></div></article>)}</div><button className="launch-reset" onClick={() => save(defaultPreferences())}>Restore default layout</button></>}
      {panel === "profile" && <ProfilePanel />}
      {panel === "tickets" && <ProfilePanel ticketsOnly />}
      {panel === "notifications" && <NotificationFeed />}
      {panel === "support" && <div className="launch-panel-message"><Compass size={32} aria-hidden /><h3>Where would you like to go?</h3><p>Use the help assistant inside CampusRide or VacationRide for service questions. Keep your payment reference when asking about a booking.</p><Link href="/campus">CampusRide help →</Link><Link href="/vacation">VacationRide help →</Link></div>}
      <p className="launch-save-status" role="status">{notice || error}</p></motion.div>
    </dialog>
  </div>;
}
