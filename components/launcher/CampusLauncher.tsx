"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Bell, BusFront, CarFront, Check, Compass, ExternalLink, Grid2X2, House, MapPin, Pin, Search, Settings2, Ticket, User, X } from "lucide-react";
import { defaultPreferences, homepageServices, isServiceHidden, services, type LauncherPreference, type Service } from "./services";
import { useLauncherLayout } from "./useLauncherLayout";
import { ProfilePanel } from "./ProfilePanel";
import { NotificationFeed } from "./NotificationFeed";
import { useNotifications } from "@/components/account/useNotifications";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import "./launcher.css";
import "./home.css";

type Panel = "services" | "customise" | "profile" | "notifications" | "support" | null;

/**
 * Partner services run on their own origin. They are the only registry entries
 * that carry a brand banner and a spotlight card, so the narrow type keeps the
 * card honest: a service without a banner cannot be rendered as one.
 */
type PartnerService = Extract<Service, { external: true }>;

function isExternal(service: Service): service is PartnerService {
  return "external" in service && service.external === true;
}

function ServiceCard({ service, pinned }: { service: Service; pinned: boolean }) {
  const Icon = service.icon;
  const external = isExternal(service);
  return <article className={`home-card is-${service.accent}`}>
    <span className="home-card-icon"><Icon size={22} aria-hidden /></span>
    <h3>{service.title}{pinned && <Pin size={13} aria-label="Pinned" />}</h3>
    <p>{service.description}</p>
    {service.destination
      ? <Link
          className="home-card-link"
          href={service.destination}
          aria-label={external ? `${service.action}: ${service.title} (opens in a new tab)` : undefined}
          {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
        >
          {service.action}{external ? <ExternalLink size={15} aria-hidden /> : <ArrowRight size={15} aria-hidden />}
        </Link>
      : <span className="home-card-soon">Coming soon</span>}
  </article>;
}

/** The full-width homepage card for one partner, built from its registry entry. */
function PartnerFeature({ service }: { service: PartnerService }) {
  const Icon = service.icon;
  const banner = service.banner;
  const titleId = `home-${service.id}-title`;
  return <section className={`home-feature is-${service.accent}`} aria-labelledby={titleId}>
    <div className="home-feature-head"><span className="home-card-icon"><Icon size={22} aria-hidden /></span><div><h2 id={titleId}>{service.title}</h2><p>{service.detail}</p></div></div>
    {banner.kind === "image"
      ? <div className="home-brand-plate"><img src={banner.src} alt={banner.alt} width="908" height="362" /></div>
      : <div className="home-brand-lockup"><img src={banner.src} alt="" width="54" height="54" /><span>{banner.word}</span></div>}
    <p className="home-feature-copy">{service.feature}</p>
    <Link className="home-cta" href={service.destination} target="_blank" rel="noreferrer noopener" aria-label={`${service.action}: ${service.title} (opens in a new tab)`}>{service.action}<ExternalLink size={17} aria-hidden /></Link>
  </section>;
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
  // The sheet only carries services that are live today; the homepage rail and
  // the full-width banner cards below read the same projection, so a hide/show
  // toggle in the sheet is reflected everywhere on this page.
  const openServices = services.filter(service => service.available);
  const comingSoon = services.filter(service => !service.available);
  const homepage = homepageServices(preferences);
  const pinned = new Set(preferences.filter(item => item.pinned).map(item => item.id));
  const matches = openServices.filter(service => `${service.title} ${service.description} ${service.detail} ${service.category} ${"feature" in service ? service.feature : ""}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <div className="launcher home">
    <a href="#home-main" className="launch-skip">Skip to services</a>
    <header className="home-bar">
      <Link href="/" className="home-brand"><img className="home-mark" src="/logo-mark.png" width="40" height="40" alt="" /><span><span className="home-wordmark">UMaTe<em>X</em>PRESS</span><p className="home-tagline">Your campus companion</p></span></Link>
      <nav className="home-nav-desktop" aria-label="campusRide areas"><Link href="/campus"><CarFront size={16} aria-hidden />campusRide</Link><Link href="/vacation"><BusFront size={16} aria-hidden />vacationRide</Link></nav>
      <div className="home-bar-actions">
        <button className="home-icon-button" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} onClick={() => setPanel("notifications")}><Bell size={20} aria-hidden />{unread > 0 && <span className="home-dot" aria-hidden />}</button>
        <button className="home-guest" onClick={() => setPanel("profile")} aria-label="Your profile"><User size={18} aria-hidden /><span>{greeting || "Guest"}</span></button>
      </div>
    </header>
    <main id="home-main" className="home-main">
      <section className="home-hero">
        <span className="home-pill"><MapPin size={13} aria-hidden /> UMaT, Tarkwa</span>
        <h1>Your campus, <em>connected.</em></h1>
        <p>A ride, a room, a little downtime. Everything you need for campus life, in one place.</p>
      </section>
      <section className="home-section" aria-labelledby="home-services-title" aria-busy={!ready}>
        <div className="home-section-head"><h2 id="home-services-title">Explore services</h2><button onClick={() => setPanel("services")}>See all<ArrowRight size={14} aria-hidden /></button></div>
        {homepage.length
          ? <div className="home-rail">{homepage.map(service => <ServiceCard key={service.id} pinned={pinned.has(service.id)} service={service} />)}</div>
          : <div className="launch-empty"><Compass size={28} aria-hidden /><h2>A little space for your favourites.</h2><p>Restore a service from Open services.</p><button onClick={() => setPanel("services")}>Discover services</button></div>}
      </section>
      {!isServiceHidden(preferences, "campus") && <section className="home-feature" aria-labelledby="home-ride-title">
        <div className="home-feature-head"><span className="home-card-icon"><CarFront size={22} aria-hidden /></span><div><h2 id="home-ride-title">CampusRide</h2><p>Trips inside campus, on demand</p></div></div>
        <ol className="home-steps">
          <li><i><MapPin size={12} aria-hidden /></i><div><small>Pickup</small><strong>Choose the pickup zone that suits you.</strong></div></li>
          <li><i><Ticket size={12} aria-hidden /></i><div><small>Seat</small><strong>Hold a seat, then pay to confirm it.</strong></div></li>
          <li><i><Check size={12} aria-hidden /></i><div><small>Ticket</small><strong>Keep your ticket link. It is the only proof of booking.</strong></div></li>
        </ol>
        <Link className="home-cta" href="/campus">Find a ride<ArrowRight size={17} aria-hidden /></Link>
      </section>}
      {!isServiceHidden(preferences, "vacation") && <section className="home-feature is-green" aria-labelledby="home-trip-title">
        <div className="home-feature-head"><span className="home-card-icon"><BusFront size={22} aria-hidden /></span><div><h2 id="home-trip-title">VacationRide</h2><p>Long-distance coach trips</p></div></div>
        <div className="home-photo"><img src="/vip-coach.png" alt="A VacationRide coach" width="560" height="300" /></div>
        <p className="home-feature-copy">Pick a route and a travel date, choose your seat, and book before the coach fills up.</p>
        <Link className="home-cta" href="/vacation">Book a seat<ArrowRight size={17} aria-hidden /></Link>
      </section>}
      {services.filter(isExternal).filter(service => !isServiceHidden(preferences, service.id)).map(service => <PartnerFeature key={service.id} service={service} />)}
      <section className="home-section" aria-labelledby="home-soon-title">
        <div className="home-section-head"><h2 id="home-soon-title">On the way</h2><span className="home-section-note">Not live yet</span></div>
        <div className="home-soon">{services.filter(service => !service.available).map(service => { const Icon = service.icon; return <article key={service.id} className={`is-${service.accent}`}><Icon size={19} aria-hidden /><h3>{service.title}</h3><p>{service.detail}</p></article>; })}</div>
      </section>
      <section id="bookings" className="home-bookings">
        <div className="home-bookings-head"><span><Ticket size={22} aria-hidden /></span><div><p>Up next</p><h2>My bookings</h2></div></div>
        <strong>Your next adventure starts with a plan.</strong>
        <p>A combined booking history isn’t available yet. Already booked? Open the ticket link saved after your payment. A pending payment is not a confirmed booking.</p>
        <Link className="home-cta" href="/vacation">Plan a trip<ArrowRight size={17} aria-hidden /></Link>
      </section>
      <section className="home-note"><Compass size={19} aria-hidden /><span>Food is on the horizon. Everything else is ready when you are.</span><button onClick={() => setPanel("support")}>Need a hand?</button></section>
      {/* Client footer only. The driver portal and the management console live on
          their own routes and are not advertised from the student homepage. */}
      <footer className="home-footer"><span><strong>UMaTeXPRESS</strong> · Made for campus life.</span><button onClick={() => setPanel("support")}>Help</button></footer>
    </main>
    <nav className="home-nav" aria-label="Home sections">
      <a href="#home-main" aria-current="page"><House size={21} aria-hidden />Home</a>
      <button onClick={() => setPanel("services")}><Grid2X2 size={21} aria-hidden />Services</button>
      <a href="#bookings"><Ticket size={21} aria-hidden />Bookings</a>
      <button onClick={() => setPanel("profile")}><User size={21} aria-hidden />Profile</button>
    </nav>
    <dialog ref={dialog} className="launch-dialog" onCancel={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null); }} aria-labelledby="launch-dialog-title">
      <div className="launch-dialog-inner"><div className="launch-dialog-heading"><h2 id="launch-dialog-title">{panel === "services" ? "Open services" : panel === "customise" ? "Make it yours" : panel === "profile" ? "Your profile" : panel === "notifications" ? "Notifications" : "Here to help"}</h2><button className="home-icon-button" aria-label="Close" onClick={() => setPanel(null)}><X size={20} aria-hidden /></button></div>
      {panel === "services" && <><label className="launch-search"><Search size={18} aria-hidden /><input aria-label="Filter open services" placeholder="Search rides, hostels, cinema…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <p className="launch-directory-note">{homepage.length} of {openServices.length} open services on your homepage.</p>
      <div className="launch-directory">{matches.map(service => { const item = preferences.find(row => row.id === service.id)!; const Icon = service.icon; return <article key={service.id}><Icon size={24} aria-hidden /><div><h3>{service.title}</h3><p>{service.description}</p>{service.destination && <Link
  href={service.destination}
  aria-label={isExternal(service) ? `${service.action}: ${service.title} (opens in a new tab)` : undefined}
  {...(isExternal(service) ? { target: "_blank", rel: "noreferrer noopener" } : {})}
>{service.action} →</Link>}</div><button aria-pressed={!item.hidden} aria-label={`${item.hidden ? "Show" : "Hide"} ${service.title} on the homepage`} onClick={() => toggle(service.id, "hidden")}>{item.hidden ? "Show" : "Hide"}</button></article>; })}{!matches.length && <p role="status">No open services match “{query}”. Try “ride” or clear your search.</p>}</div>
      {comingSoon.length > 0 && <p className="launch-directory-note">Coming soon: {comingSoon.map(service => service.title).join(", ")}.</p>}
      <button className="launch-reset" onClick={() => setPanel("customise")}><Settings2 size={16} aria-hidden /> Customise layout</button></>}
      {panel === "customise" && <><p>Pin favourites to the top, hide widgets, or move them with the arrows. Your choices stay on this device.</p><div className="launch-customise">{preferences.map((item, index) => <article key={item.id}><strong>{services.find(service => service.id === item.id)!.title}</strong><div><button aria-label={`Pin ${item.id}`} aria-pressed={item.pinned} onClick={() => toggle(item.id, "pinned")}><Pin size={17} aria-hidden /></button><button aria-label={`Move ${item.id} earlier`} disabled={index === 0} onClick={() => move(item.id, -1)}><ArrowUp size={17} aria-hidden /></button><button aria-label={`Move ${item.id} later`} disabled={index === preferences.length - 1} onClick={() => move(item.id, 1)}><ArrowDown size={17} aria-hidden /></button><button aria-pressed={!item.hidden} onClick={() => toggle(item.id, "hidden")}>{item.hidden ? "Show" : "Hide"}</button></div></article>)}</div><button className="launch-reset" onClick={() => save(defaultPreferences())}>Restore default layout</button></>}
      {panel === "profile" && <ProfilePanel />}
      {panel === "notifications" && <NotificationFeed />}
      {panel === "support" && <div className="launch-panel-message"><Compass size={32} aria-hidden /><h3>Where would you like to go?</h3><p>Use the help assistant inside CampusRide or VacationRide for service questions. Keep your payment reference when asking about a booking.</p><Link href="/campus">CampusRide help →</Link><Link href="/vacation">VacationRide help →</Link></div>}
      <p className="launch-save-status" role="status">{notice || error}</p></div>
    </dialog>
  </div>;
}
