import { services } from "@/components/launcher/services";

export const CURIOSITY_POLICY_VERSION = "curiosity-m1-1";

export type CuriosityIntent = "travel" | "housing" | "food" | "print" | "social" | "research" | "unknown";
export type TravelChoice = "campus" | "home";
export type CuriosityServiceId = "campus" | "vacation" | "hostels" | "food" | "print-copy" | "cinema";

export type CuriosityCapability = {
  id: CuriosityServiceId;
  title: string;
  href: string;
  launched: boolean;
  explanation: string;
};

const explanations: Record<CuriosityServiceId, string> = {
  campus: "You chose travel around campus. Explore CampusRide zones and check the current fare and seats before requesting a ride.",
  vacation: "You chose travel home. Explore VacationRide routes and dates; check the current fare and seats before booking.",
  hostels: "You chose a place to stay. Explore approved Hostel Finder properties and check current bed details before deciding.",
  food: "You chose food. Explore provider listings and confirm current menu details before ordering.",
  "print-copy": "You chose printing. Explore recently verified shops; prices and turnaround are indicative until the shop confirms a quote.",
  cinema: "You chose a break. Explore OnlineCinema rooms and events; check the current session details before joining.",
};

export const curiosityServiceIds = Object.keys(explanations) as CuriosityServiceId[];

/** Server-owned capability data is bounded by the current launcher release state. */
export function curiosityCatalog(): CuriosityCapability[] {
  return curiosityServiceIds.map((id) => {
    const entry = services.find((service) => service.id === id);
    const href = entry?.available && typeof entry.destination === "string" && entry.destination.startsWith("/") && !entry.destination.startsWith("//")
      ? entry.destination : "";
    return { id, title: entry?.title || id, href, launched: Boolean(href), explanation: explanations[id] };
  });
}
