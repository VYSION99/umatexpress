import Link from "next/link";
import { Bus, Car, House } from "lucide-react";

type NavLink = { href: string; label: string; icon: typeof House };

// The public campus shell only ever speaks for the student areas. The console
// has an origin of its own, so it is not advertised from a student page.
const NAV: NavLink[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/campus", label: "campusRide", icon: Car },
  { href: "/vacation", label: "vacationRide", icon: Bus },
];

/** Which public entry point the shell is currently showing. */
export function campusNavState(area: string): { activeHref: string } {
  // The account page belongs to the whole platform, so no area is current.
  if (area.includes("ACCOUNT")) return { activeHref: "" };
  return { activeHref: "/campus" };
}

export function CampusNav({ area, variant }: { area: string; variant: "desktop" | "mobile" }) {
  const { activeHref } = campusNavState(area);
  return <nav className={`campus-nav campus-nav--${variant}`} aria-label="campusRide areas">
    {NAV.map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={href === activeHref ? "page" : undefined} className={href === activeHref ? "is-current" : undefined}>
      <Icon size={variant === "mobile" ? 19 : 15} aria-hidden />
      <span>{label}</span>
    </Link>)}
  </nav>;
}
