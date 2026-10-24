"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { services } from "@/components/launcher/services";
import { AppBottomSheet } from "./AppBottomSheet";
import { DockIcon, type DockGlyph } from "./DockIcon";
import { FloatingDock, type DockItem } from "./FloatingDock";

const glyphs: Record<string, DockGlyph> = {
  campus: "car", vacation: "bus", hostels: "bed", cinema: "film", food: "food",
  research: "services", clipad: "services",
};

export function PublicFloatingDock() {
  const pathname = usePathname() || "/";
  const [sheet, setSheet] = useState({ pathname, open: false });
  const open = sheet.pathname === pathname && sheet.open;
  const close = () => setSheet({ pathname, open: false });

  // The Cinema room has its own media toolbar. A second dock would cover its
  // playback and conversation controls on a phone.
  if (pathname.startsWith("/cinema/") && pathname !== "/cinema/events" && pathname !== "/cinema/rooms" && !pathname.startsWith("/cinema/events/")) return null;

  let local: DockItem[];
  if (pathname.startsWith("/campus")) local = [
    { id: "rides", label: "Rides", icon: "car", href: "/campus", active: pathname === "/campus" },
    { id: "ticket", label: "Ticket", icon: "ticket", href: "/campus/ticket", active: pathname.startsWith("/campus/ticket") },
  ];
  else if (pathname.startsWith("/vacation")) local = [
    { id: "trips", label: "Trips", icon: "bus", href: "/vacation", active: true },
    { id: "stay", label: "Hostels", icon: "bed", href: "/hostel" },
  ];
  else if (pathname.startsWith("/hostel")) local = [
    { id: "hostels", label: "Find", icon: "bed", href: "/hostel", active: pathname === "/hostel" },
    { id: "resident", label: "Resident", icon: "account", href: "/hostel/resident", active: pathname.startsWith("/hostel/resident") },
  ];
  else if (pathname.startsWith("/cinema")) local = [
    { id: "events", label: "Events", icon: "film", href: "/cinema/events", active: pathname.startsWith("/cinema/events") },
    { id: "rooms", label: "Rooms", icon: "services", href: "/cinema/rooms", active: pathname === "/cinema/rooms" },
  ];
  else if (pathname.startsWith("/food")) local = [
    { id: "food", label: "Food", icon: "food", href: "/food", active: true },
    { id: "cinema", label: "Cinema", icon: "film", href: "/cinema" },
  ];
  else if (pathname === "/profile") local = [
    { id: "profile", label: "Profile", icon: "account", href: "/profile", active: true },
    { id: "tickets", label: "Tickets", icon: "ticket", href: "/campus/ticket" },
  ];
  else local = [
    { id: "rides", label: "Rides", icon: "car", href: "/campus" },
    { id: "hostels", label: "Hostels", icon: "bed", href: "/hostel" },
  ];

  return <>
    <FloatingDock items={[
      { id: "home", label: "Home", icon: "home", href: "/" },
      ...local,
      { id: "more", label: "More", icon: "services", onSelect: () => setSheet({ pathname, open: true }) },
    ]} label="Student navigation" />
    <AppBottomSheet open={open} title="Explore services" onClose={close}>
      <div className="app-dock-sheet-inner">
        <header><h2>Explore services</h2><button type="button" onClick={close} aria-label="Close services">Close</button></header>
        <p>Choose where you want to go next.</p>
        <nav aria-label="Available services" className="app-dock-directory">
          {services.filter(service => service.available).map(service => <Link key={service.id} href={service.destination}
            onClick={close} {...("external" in service && service.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            <DockIcon name={glyphs[service.id] || "services"} size={29} />
            <span><strong>{service.title}</strong><small>{service.description}</small></span>
            <span aria-hidden>›</span>
          </Link>)}
        </nav>
      </div>
    </AppBottomSheet>
  </>;
}
