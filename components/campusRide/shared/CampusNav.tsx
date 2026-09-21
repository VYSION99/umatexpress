"use client";

import Link from "next/link";
import { House } from "lucide-react";
import { navLabel, navServices } from "@/components/launcher/services";
import { useLauncherLayout } from "@/components/launcher/useLauncherLayout";

type NavLink = { href: string; label: string; icon: typeof House };

/**
 * The public shell's bars: the pill row in a desktop hero, and the fixed bottom
 * bar on a phone. The entries are the live services, not a list kept here — a
 * service that opens appears the day it is registered, and one a student
 * switched off in the launcher's Open services sheet leaves the bar with it.
 * Partner services open on their own origin in a new tab, so they stay on the
 * homepage's banner cards; these bars only move inside the app. The console has
 * an origin of its own, so it is not advertised from a student page either.
 */

/** Which public entry point the shell is currently showing. */
export function campusNavState(area: string): { activeHref: string } {
  // The account page belongs to the whole platform, so no area is current.
  if (area.includes("ACCOUNT")) return { activeHref: "" };
  if (area.includes("HOSTEL")) return { activeHref: "/hostel" };
  if (area.includes("CINEMA")) return { activeHref: "/cinema" };
  if (area.includes("VACATION")) return { activeHref: "/vacation" };
  return { activeHref: "/campus" };
}

export function CampusNav({ area, variant }: { area: string; variant: "desktop" | "mobile" }) {
  const { activeHref } = campusNavState(area);
  const { preferences } = useLauncherLayout();
  const links: NavLink[] = [
    { href: "/", label: "Home", icon: House },
    ...navServices(preferences).map((service) => ({ href: service.destination, label: navLabel(service), icon: service.icon })),
  ];
  return <nav className={`campus-nav campus-nav--${variant}`} aria-label="UMaTeXPRESS areas">
    {links.map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={href === activeHref ? "page" : undefined} className={href === activeHref ? "is-current" : undefined}>
      <Icon size={variant === "mobile" ? 19 : 15} aria-hidden />
      <span>{label}</span>
    </Link>)}
  </nav>;
}
