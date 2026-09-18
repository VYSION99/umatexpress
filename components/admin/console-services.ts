import { BedDouble, BusFront, CarFront, Clapperboard, LockKeyhole, MapPinned, Store, Utensils } from "lucide-react";
import type { LauncherPreference } from "@/components/launcher/services";

export const consoleServices = [
  { id: "campus", title: "CampusRide", icon: CarFront, accent: "blue", href: "/admin/campus", label: "CAMPUS OPERATIONS", description: "Keep campus moving.", detail: "Zones, routes, drivers, vehicles and ride queues.", action: "Open CampusRide", tags: ["Drivers & vehicles", "Zones & fares"] },
  { id: "vacation", title: "VacationRide", icon: BusFront, accent: "orange", href: "/admin/vacation", label: "TRIPS & PASSENGERS", description: "Every journey, organised.", detail: "Schedules, fares, passenger records and bookings.", action: "Manage trips", tags: ["Trip scheduler", "Passenger records"] },
  { id: "driver", title: "Driver portal", icon: MapPinned, accent: "green", href: "/driver", label: "BOARDING & QUEUES", description: "From pickup to arrival.", detail: "Open the driver workspace. A separate driver sign-in is required.", action: "Open driver portal", tags: ["Driver access"] },
  { id: "security", title: "Account security", icon: LockKeyhole, accent: "purple", href: "/admin/change-password", label: "ADMIN ACCESS", description: "Look after your access.", detail: "Update the administrator password from the protected security page.", action: "Change password", tags: ["Password settings"] },
  { id: "hostels", title: "Hostel Finder", icon: BedDouble, accent: "green", href: null, label: "ACCOMMODATION", description: "A home for every student.", detail: "Hostel management is not available yet.", action: "Coming soon", tags: [] },
  { id: "organizers", title: "Organizer applications", icon: Store, accent: "orange", href: "/console/organizers", label: "SELF-SERVICE TRIPS", description: "Approve who publishes coaches.", detail: "Review applications, activate or suspend organizers, and assign trips to them.", action: "Review applications", tags: ["Applications", "Trip ownership"] },
  { id: "organizer", title: "Organizer workspace", icon: BusFront, accent: "orange", href: "/console/trips", label: "MY TRIPS", description: "Your coaches and passengers.", detail: "The trips you own, their passenger manifests and your trip notice.", action: "Open workspace", tags: ["Trips", "Manifests"] },
  { id: "food", title: "Food", icon: Utensils, accent: "peach", href: null, label: "CAMPUS DINING", description: "Something good is coming.", detail: "Vendor and order management is not available yet.", action: "Coming soon", tags: [] },
  { id: "cinema", title: "OnlineCinema", icon: Clapperboard, accent: "purple", href: null, label: "ENTERTAINMENT", description: "A place for movie nights.", detail: "Cinema management is not available yet.", action: "Coming soon", tags: [] },
] as const;
export const consoleDefaults = (): LauncherPreference[] => consoleServices.map(service => ({ id: service.id, pinned: false, hidden: !service.href }));
export function normalizeConsoleLayout(value: unknown): LauncherPreference[] {
  if (!Array.isArray(value)) return consoleDefaults();
  const rows: LauncherPreference[] = [];
  for (const item of value) {
    if (item && consoleServices.some(service => service.id === item.id) && !rows.some(row => row.id === item.id)) rows.push({ id: item.id, hidden: item.hidden === true, pinned: item.pinned === true });
  }
  return [...rows, ...consoleDefaults().filter(item => !rows.some(row => row.id === item.id))];
}

/**
 * One console, four roles. A service is only offered to the roles that may use
 * it, and this list is presentation only: the matching API re-checks the role
 * from the signed session on every request.
 */
export function consoleServicesForRole(role: string) {
  if (role === "ADMIN") return [...consoleServices];
  // Role order matters: the role's own workspace leads and account security is
  // always last, so the first card is the one the person signed in to use.
  const order: Record<string, string[]> = {
    MODERATOR: ["organizers", "vacation", "hostels", "security"],
    DRIVER: ["driver", "security"],
    ORGANIZER: ["organizer", "security"],
  };
  return (order[role] || ["security"]).flatMap((id) => consoleServices.filter((service) => service.id === id));
}
