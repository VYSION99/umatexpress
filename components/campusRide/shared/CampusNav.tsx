import Link from "next/link";
import { Bus, Car, House, IdCard, LayoutGrid } from "lucide-react";

type Audience = "student" | "driver" | "admin";

type NavLink = { href: string; label: string; icon: typeof House };

// Each audience gets its own navigation. A student page must not advertise the
// management console, and the console must not be reachable from a driver page:
// the three areas are separate routes, not panels inside one another.
const NAV: Record<Audience, NavLink[]> = {
  student: [
    { href: "/", label: "Home", icon: House },
    { href: "/campus", label: "campusRide", icon: Car },
    { href: "/vacation", label: "vacationRide", icon: Bus },
  ],
  driver: [
    { href: "/driver", label: "Driver", icon: IdCard },
    { href: "/", label: "Home", icon: House },
  ],
  admin: [
    { href: "/admin", label: "Console", icon: LayoutGrid },
    { href: "/admin/campus", label: "campusRide", icon: Car },
    { href: "/admin/vacation", label: "vacationRide", icon: Bus },
  ],
};

const AREA_LABEL: Record<Audience, string> = {
  student: "campusRide areas",
  driver: "Driver areas",
  admin: "Management areas",
};

export function campusNavState(area: string): { audience: Audience; activeHref: string } {
  if (area.includes("ADMIN")) return { audience: "admin", activeHref: "/admin/campus" };
  if (area.includes("DRIVER")) return { audience: "driver", activeHref: "/driver" };
  // The account page belongs to the whole platform, so no area is current.
  if (area.includes("ACCOUNT")) return { audience: "student", activeHref: "" };
  return { audience: "student", activeHref: "/campus" };
}

export function CampusNav({ area, variant }: { area: string; variant: "desktop" | "mobile" }) {
  const { audience, activeHref } = campusNavState(area);
  return <nav className={`campus-nav campus-nav--${variant}`} aria-label={AREA_LABEL[audience]}>
    {NAV[audience].map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={href === activeHref ? "page" : undefined} className={href === activeHref ? "is-current" : undefined}>
      <Icon size={variant === "mobile" ? 19 : 15} aria-hidden />
      <span>{label}</span>
    </Link>)}
  </nav>;
}
