"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, ArrowSquareOut, MagnifyingGlass, X } from "@/components/ui/MaterialIcon";
import { services, type OpenService } from "./services";

const filters = [
  { id: "all", label: "All", services: [] },
  { id: "rides", label: "Rides", services: ["campus", "vacation"] },
  { id: "living", label: "Living", services: ["hostels"] },
  { id: "watch", label: "Watch", services: ["cinema"] },
  { id: "partners", label: "Partners", services: ["research", "clipad"] },
] as const;

const searchTerms: Record<string, string> = {
  campus: "shuttle transport campus ride",
  vacation: "travel bus home vacation ride",
  hostels: "accommodation housing rooms beds hostel",
  cinema: "movie video event discussion watch",
  research: "acmd projects mentorship",
  clipad: "meetings collaboration notes",
};

export function HomeServiceSearch() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const selected = filters.find(item => item.id === filter);
    return services.filter((service): service is OpenService => service.available)
      .filter(service => filter === "all" || selected?.services.some(id => id === service.id))
      .filter(service => {
        const haystack = `${service.title} ${service.description} ${service.detail} ${service.category} ${searchTerms[service.id] || ""}`.toLocaleLowerCase();
        return words.every(word => haystack.includes(word));
      });
  }, [filter, query]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onShortcut(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey ||
        target?.matches("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      input.current?.focus();
      setOpen(true);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onShortcut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onShortcut);
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      input.current?.focus();
      return;
    }
    const links = Array.from(root.current?.querySelectorAll<HTMLAnchorElement>(".home-search-result") || []);
    if (event.key === "Enter" && event.target === input.current && links.length) {
      event.preventDefault();
      links[0].click();
    } else if (event.key === "ArrowDown" && links.length) {
      event.preventDefault();
      const index = links.indexOf(document.activeElement as HTMLAnchorElement);
      links[Math.min(index + 1, links.length - 1)].focus();
    } else if (event.key === "ArrowUp" && links.length && event.target !== input.current) {
      event.preventDefault();
      const index = links.indexOf(document.activeElement as HTMLAnchorElement);
      if (index <= 0) input.current?.focus();
      else links[index - 1].focus();
    }
  }

  return <div className="home-service-search" ref={root} onKeyDown={onKeyDown}>
    <div className="home-search-field">
      <MagnifyingGlass size={20} aria-hidden />
      <input ref={input} type="search" role="combobox" aria-label="Search services" aria-expanded={open}
        aria-haspopup="dialog" aria-controls="home-search-results" autoComplete="off" placeholder="Search rides, hostels, cinema…"
        value={query} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onChange={event => { setQuery(event.target.value); setOpen(true); }} />
      {query ? <button type="button" className="home-search-clear" aria-label="Clear search" onClick={() => { setQuery(""); input.current?.focus(); }}><X size={17} aria-hidden /></button>
        : <kbd aria-hidden>/</kbd>}
    </div>
    {open && <div className="home-search-panel" id="home-search-results" role="dialog" aria-label="Service search results">
      <div className="home-search-panel-heading"><strong>Find a service</strong><span role="status" aria-live="polite">{results.length} available</span></div>
      <div className="home-search-filters" aria-label="Filter services">
        {filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id}
          onClick={() => { setFilter(item.id); input.current?.focus(); }}>{item.label}</button>)}
      </div>
      <div className="home-search-results">
        {results.length ? results.map(service => {
          const Icon = service.icon;
          const external = "external" in service && service.external;
          return <Link key={service.id} className="home-search-result" href={service.destination}
            onClick={() => setOpen(false)} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            <span className="home-search-result-icon"><Icon size={19} aria-hidden /></span>
            <span><strong>{service.title}</strong><small>{service.detail}</small></span>
            {external ? <ArrowSquareOut size={16} aria-hidden /> : <ArrowRight size={16} aria-hidden />}
          </Link>;
        }) : <p className="home-search-empty">No services match your search. Try a different word or filter.</p>}
      </div>
      <p className="home-search-hint">Press Enter to open the first result · Esc to close</p>
    </div>}
  </div>;
}
