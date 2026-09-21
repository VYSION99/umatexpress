import { BedDouble, BrainCircuit, BusFront, CarFront, Clapperboard, FlaskConical, Utensils } from "lucide-react";

// The launcher registry is deliberately independent of server-only business logic.
// `accent` is the homepage card tint: the three brand colours, rotated so no two
// neighbouring cards share a hue. Nothing here may claim data the app cannot back.
export const services = [
  { id: "campus", title: "CampusRide", icon: CarFront, accent: "cyan", available: true, destination: "/campus", action: "Find a ride", description: "Move around campus.", detail: "Zones, seats and fares", category: "Around campus" },
  { id: "vacation", title: "VacationRide", icon: BusFront, accent: "green", available: true, destination: "/vacation", action: "Book a seat", description: "Next stop, home.", detail: "Choose a route and travel date", category: "Beyond campus" },
  { id: "hostels", title: "Hostel Finder", navLabel: "Hostels", icon: BedDouble, accent: "yellow", available: true, destination: "/hostel", action: "Explore hostels", description: "Find your own corner of campus.", detail: "Places to settle in", category: "Make yourself at home" },
  { id: "food", title: "Food", icon: Utensils, accent: "cyan", available: false, destination: null, action: "Explore food", description: "Good food. Better study breaks.", detail: "Your next favourite bite", category: "A little refuel" },
  { id: "cinema", title: "OnlineCinema", navLabel: "Cinema", icon: Clapperboard, accent: "green", available: true, destination: "/cinema", action: "Open a room", description: "Watch together, wherever you are.", detail: "One link, one video, one conversation", category: "After the lectures" },
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

/**
 * The homepage banner/rail projection: only services that are live today and
 * that the student has not switched off, in their saved order with pinned
 * cards first. Coming-soon entries stay out of the sheet and live in the
 * "On the way" strip, so the hide/show controls never reference a dead card.
 */
export function homepageServices(preferences: LauncherPreference[]): Service[] {
  return normalizePreferences(preferences)
    .map(row => ({ row, service: services.find(service => service.id === row.id) }))
    .filter((entry): entry is { row: LauncherPreference; service: Service } => Boolean(entry.service?.available))
    .filter(entry => !entry.row.hidden)
    .sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned))
    .map(entry => entry.service);
}

/** True when the student has switched this service off on the homepage. */
export function isServiceHidden(preferences: LauncherPreference[], id: string): boolean {
  return preferences.some(row => row.id === id && row.hidden);
}

/** A live service whose destination stays inside the app — a candidate for the shell's bottom bar. */
type NavService = Extract<Service, { destination: string }>;

/**
 * The public shell's bottom bar reads this: the live services that belong
 * inside the app, in the same order as the homepage's rail and banner cards,
 * minus anything the student switched off in the launcher's Open services
 * sheet. Partner services open on their own origin in a new tab, so the bar
 * leaves them to the homepage banners; it only moves inside the app.
 */
export function navServices(preferences: LauncherPreference[]): NavService[] {
  return homepageServices(preferences).filter(
    (service): service is NavService => typeof service.destination === "string" && service.destination.startsWith("/"),
  );
}

/** The short name the bar uses where a title is too long for a phone. */
export function navLabel(service: Service): string {
  return "navLabel" in service && service.navLabel ? service.navLabel : service.title;
}
