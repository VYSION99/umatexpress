import { BedDouble, BrainCircuit, BusFront, CarFront, Clapperboard, FlaskConical, Utensils } from "lucide-react";

// The launcher registry is deliberately independent of server-only business logic.
// `accent` is the homepage card tint: the three brand colours, rotated so no two
// neighbouring cards share a hue. Nothing here may claim data the app cannot back.
export const services = [
  { id: "campus", title: "CampusRide", icon: CarFront, accent: "cyan", available: true, destination: "/campus", action: "Find a ride", description: "Move around campus.", detail: "Zones, seats and fares", category: "Around campus" },
  { id: "vacation", title: "VacationRide", icon: BusFront, accent: "green", available: true, destination: "/vacation", action: "Book a seat", description: "Next stop, home.", detail: "Choose a route and travel date", category: "Beyond campus" },
  { id: "hostels", title: "Hostel Finder", icon: BedDouble, accent: "yellow", available: false, destination: null, action: "Explore hostels", description: "Find your own corner of campus.", detail: "Places to settle in", category: "Make yourself at home" },
  { id: "food", title: "Food", icon: Utensils, accent: "cyan", available: false, destination: null, action: "Explore food", description: "Good food. Better study breaks.", detail: "Your next favourite bite", category: "A little refuel" },
  { id: "cinema", title: "OnlineCinema", icon: Clapperboard, accent: "green", available: false, destination: null, action: "Explore cinema", description: "Make room for movie night.", detail: "Stories worth sharing", category: "After the lectures" },
  // Partner services that already run outside this app. `external` makes the
  // card open a new tab instead of routing inside the platform, the accent
  // rotation keeps two neighbours from sharing a hue, and the fields below the
  // directory entry — `feature` and `banner` — build the full-width
  // spotlight card on the homepage with the partner's own brand asset.
  { id: "research", title: "ACMD Research", icon: FlaskConical, accent: "yellow", available: true, external: true, destination: "https://acmdresearch.com", action: "Open the hub", description: "Research, mentorship and innovation.", detail: "Projects with mentors and industry", feature: "Join research and innovation projects with mentors and industry partners across AI, biotech and cybersecurity.", banner: { kind: "image", src: "/acmd-logo.png", alt: "ACMD Research" }, category: "Research & innovation" },
  { id: "clipad", title: "CliPad", icon: BrainCircuit, accent: "cyan", available: true, external: true, destination: "https://clipad.optavel.com", action: "Open CliPad", description: "Meetings and team memory, in one place.", detail: "Team spaces, async video and AI summaries", feature: "Team spaces, async video and AI meeting summaries: the decisions and context your team builds, kept in one place.", banner: { kind: "mark", src: "/clipad-mark.svg", word: "CliPad" }, category: "Work & collaboration" },
] as const;
export type Service = typeof services[number];
export type LauncherPreference = { id: string; hidden: boolean; pinned: boolean };
export const defaultPreferences = (): LauncherPreference[] => services.map(({ id }) => ({ id, hidden: false, pinned: false }));
export function normalizePreferences(value: unknown): LauncherPreference[] {
  if (!Array.isArray(value)) return defaultPreferences();
  const result: LauncherPreference[] = [];
  for (const item of value) {
    if (item && services.some(service => service.id === item.id) && !result.some(row => row.id === item.id)) {
      result.push({ id: item.id, hidden: item.hidden === true, pinned: item.pinned === true });
    }
  }
  return [...result, ...defaultPreferences().filter(item => !result.some(row => row.id === item.id))];
}
