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
  stageOrder: number;
  uncertaintyNote: string;
};

const explanations: Record<CuriosityServiceId, string> = {
  campus: "You chose travel around campus. Explore CampusRide zones and check the current fare and seats before requesting a ride.",
  vacation: "You chose travel home. Explore VacationRide routes and dates; check the current fare and seats before booking.",
  hostels: "You chose a place to stay. Explore approved Hostel Finder properties and check current bed details before deciding.",
  food: "You chose food. Explore provider listings and confirm current menu details before ordering.",
  "print-copy": "You chose printing. Explore recently verified shops; prices and turnaround are indicative until the shop confirms a quote.",
  cinema: "You chose a break. Explore OnlineCinema rooms and events; check the current session details before joining.",
};

const stageOrders: Record<CuriosityServiceId, number> = {
  "print-copy": 1,
  food: 1,
  campus: 2,
  vacation: 3,
  hostels: 3,
  cinema: 3,
};

const uncertaintyNotes: Record<CuriosityServiceId, string> = {
  campus: "Check the live zone queue and fare before joining a ride.",
  vacation: "Seat availability and fares are confirmed during checkout.",
  hostels: "Bed availability and rates are confirmed on the property listing.",
  food: "Menu items and prices are confirmed with the vendor before ordering.",
  "print-copy": "Prices and turnaround are indicative until the shop confirms a quote.",
  cinema: "Room access and session schedules depend on the host’s current settings.",
};

export const curiosityServiceIds = Object.keys(explanations) as CuriosityServiceId[];

/** Server-owned capability data is bounded by the current launcher release state. */
export function curiosityCatalog(): CuriosityCapability[] {
  return curiosityServiceIds.map((id) => {
    const entry = services.find((service) => service.id === id);
    const href = entry?.available && typeof entry.destination === "string" && entry.destination.startsWith("/") && !entry.destination.startsWith("//")
      ? entry.destination : "";
    return {
      id,
      title: entry?.title || id,
      href,
      launched: Boolean(href),
      explanation: explanations[id],
      stageOrder: stageOrders[id],
      uncertaintyNote: uncertaintyNotes[id],
    };
  });
}
