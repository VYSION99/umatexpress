"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Check, ExternalLink, Grid2X2, Home, LockKeyhole, LogOut, Pin, Search, Settings2, ShieldCheck, Sparkles, X } from "lucide-react";
import { useLauncherLayout } from "@/components/launcher/useLauncherLayout";
import type { LauncherPreference } from "@/components/launcher/services";
import { consoleDefaults, consoleServices, normalizeConsoleLayout } from "./console-services";
import "@/components/launcher/launcher.css";
import "./console.css";

export default function ConsoleLauncher() {
  const { preferences, save: persist, ready, error } = useLauncherLayout("umatexpress.console.v1", consoleDefaults, normalizeConsoleLayout);
  const [panel, setPanel] = useState<"services" | "customise" | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (panel) dialog.current?.showModal(); else dialog.current?.close(); }, [panel]);
  function save(next: LauncherPreference[]) { setNotice(persist(next) ? "Console layout saved on this device." : "Layout updated for this visit; browser storage is unavailable."); }
  function toggle(id: string, field: "hidden" | "pinned") { save(preferences.map(row => row.id === id ? { ...row, [field]: !row[field] } : row)); }
  function move(id: string, offset: number) {
    const next = [...preferences]; const index = next.findIndex(row => row.id === id); const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; save(next);
  }
  async function signOut() {
    setSigningOut(true); setSignOutError("");
    try {
      const response = await fetch("/api/admin/auth", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Sign-out failed. Please try again.");
      window.location.assign("/admin/login");
    } catch { setSignOutError("Could not sign out. Check your connection and try again."); setSigningOut(false); }
  }
  const shown = preferences.filter(row => !row.hidden).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const matches = consoleServices.filter(service => `${service.title} ${service.detail} ${service.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="launcher console-launcher">
    <a href="#console-main" className="launch-skip">Skip to management tools</a>
    <aside className="console-sidebar"><Link href="/admin" className="launch-brand"><img src="/logo.svg" width="44" height="44" alt=""/><span>UMaTe<span>XPRESS</span><small>Management console</small></span></Link><span className="console-sidebar-label">WORKSPACE</span><nav aria-label="Management navigation"><Link href="/admin" aria-current="page"><Home size={19}/> Overview</Link><button onClick={() => setPanel("services")}><Grid2X2 size={19}/> All services</button><Link href="/admin/change-password"><LockKeyhole size={19}/> Security</Link></nav><span className="console-sidebar-label">YOUR APPS</span><nav aria-label="Admin applications">{consoleServices.filter(service => service.href && ["campus", "vacation"].includes(service.id)).map(service => { const Icon = service.icon; return <Link href={service.href!} key={service.id}><Icon size={19}/>{service.title}</Link>; })}</nav><div className="console-sidebar-bottom"><Link href="/"><ExternalLink size={17}/> Student homepage</Link><span><ShieldCheck size={18}/> Administrator workspace</span></div></aside>
    <div className="console-workspace"><header className="console-topbar"><Link href="/admin" className="console-mobile-brand" aria-label="UMaTeXPRESS management home"><img src="/logo.svg" width="40" height="40" alt=""/><span>Console</span></Link><span className="console-breadcrumb">Workspace <span>/</span> Overview</span><form className="launch-search" onSubmit={event => { event.preventDefault(); setPanel("services"); }}><Search size={18}/><input aria-label="Search management tools" placeholder="Find a service or tool…" value={query} onChange={event => setQuery(event.target.value)}/><button aria-label="Search console"><ArrowRight size={17}/></button></form><button className="console-signout" onClick={signOut} disabled={signingOut}><LogOut size={17}/><span>{signingOut ? "Signing out…" : "Sign out"}</span></button></header>
    <main id="console-main" className="launch-main"><section className="launch-greeting"><div><p>YOUR MANAGEMENT WORKSPACE <span aria-hidden="true">✦</span></p><h1>One campus. One console.</h1><span>Open an app, take care of the details, keep things moving.</span></div><span className="launch-campus-label"><ShieldCheck size={16}/> Admin access</span></section>
    {signOutError && <p className="console-error" role="alert">{signOutError}</p>}
    <div className="launch-section-bar"><h2>Your management apps</h2><div><button onClick={() => setPanel("services")}><Grid2X2 size={16}/> All services</button><button onClick={() => setPanel("customise")}><Settings2 size={16}/> Customise</button></div></div>
    <section className="console-grid" aria-label="Management apps" aria-busy={!ready}>{shown.map(row => { const service = consoleServices.find(item => item.id === row.id)!; const Icon = service.icon; return <article className={`launch-widget launch-${service.accent}`} key={row.id}><div className="launch-widget-heading"><span className="launch-icon"><Icon size={23}/></span><span>{service.title}</span>{row.pinned && <Pin size={15} aria-label="Pinned"/>}{!service.href && <span className="launch-soon">Coming soon</span>}</div><div className="launch-widget-copy"><p className="launch-eyebrow">{service.label}</p><h2>{service.description}</h2><p className="launch-detail">{service.detail}</p></div><div className="console-tags">{service.tags.map(tag => <span key={tag}>{tag}</span>)}</div>{service.href ? <Link className="launch-action" href={service.href}>{service.action}<ArrowRight size={18}/></Link> : <span className="launch-unavailable">Coming soon</span>}</article>; })}{!shown.length && <div className="launch-empty"><Grid2X2 size={30}/><h2>Your workspace, your choices.</h2><p>Add tools back from All services.</p><button onClick={() => setPanel("services")}>Browse management tools</button></div>}</section>
    <section className="console-shortcuts"><div><Sparkles size={23}/><span><strong>Help, right where you work.</strong><p>Find contextual AI assistance inside CampusRide and VacationRide.</p></span></div><Link href="/admin/campus">Open CampusRide <ArrowRight size={17}/></Link></section>
    <footer className="launch-footer"><span>UMaTeXPRESS <small>Management console</small></span><div><Link href="/">Student homepage</Link><Link href="/driver">Driver portal</Link></div></footer></main></div>
    <nav className="launch-mobile-nav" aria-label="Console mobile navigation"><Link href="/admin" aria-current="page"><Home size={21}/>Overview</Link><button onClick={() => setPanel("services")}><Grid2X2 size={21}/>Services</button><button onClick={() => setPanel("customise")}><Settings2 size={21}/>Customise</button><Link href="/admin/change-password"><LockKeyhole size={21}/>Security</Link></nav>
    <dialog ref={dialog} className="launch-dialog" aria-labelledby="console-panel-title" onCancel={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null); }}><div className="launch-dialog-inner"><div className="launch-dialog-heading"><h2 id="console-panel-title">{panel === "services" ? "Management services" : "Your console layout"}</h2><button className="launch-icon-button" aria-label="Close" onClick={() => setPanel(null)}><X size={21}/></button></div>
    {panel === "services" && <><label className="launch-search"><Search size={18}/><input aria-label="Filter management services" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps, drivers, trips…"/></label><div className="launch-directory">{matches.map(service => { const Icon = service.icon; const row = preferences.find(item => item.id === service.id)!; return <article key={service.id}><Icon size={23}/><div><h3>{service.title}</h3><p>{service.href ? service.detail : "Coming soon"}</p>{service.href && <Link href={service.href}>{service.action} →</Link>}</div><button aria-label={`${row.hidden ? "Show" : "Hide"} ${service.title}`} onClick={() => toggle(row.id, "hidden")}>{row.hidden ? "Add" : <><Check size={16}/>Added</>}</button></article>; })}{!matches.length && <p role="status">No matching tools. Try “drivers”, “trips”, or “security”.</p>}</div></>}
    {panel === "customise" && <><p>Pin tools to the top, hide widgets, or use the arrows to reorder each pin group. These choices apply only to your console on this device.</p><div className="launch-customise">{preferences.map((row, index) => <article key={row.id}><strong>{consoleServices.find(service => service.id === row.id)!.title}</strong><div><button aria-label={`Pin ${row.id}`} aria-pressed={row.pinned} onClick={() => toggle(row.id, "pinned")}><Pin size={17}/></button><button aria-label={`Move ${row.id} earlier`} disabled={index === 0} onClick={() => move(row.id, -1)}><ArrowUp size={17}/></button><button aria-label={`Move ${row.id} later`} disabled={index === preferences.length - 1} onClick={() => move(row.id, 1)}><ArrowDown size={17}/></button><button aria-pressed={!row.hidden} onClick={() => toggle(row.id, "hidden")}>{row.hidden ? "Show" : "Hide"}</button></div></article>)}</div><button className="launch-reset" onClick={() => save(consoleDefaults())}>Restore default layout</button></>}
    <p className="launch-save-status" role="status">{notice || error}</p></div></dialog>
  </div>;
}
