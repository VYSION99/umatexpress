import { Banknote, BedDouble, BusFront, CarFront, Clapperboard, IdCard, LockKeyhole, MapPinned, Scale, Store, Utensils, Wallet } from "lucide-react";

/**
 * The console is one console for every UMaTeXPRESS service, the way a cloud
 * console is one console for every product. A service is a product area with
 * its own navigation; a role decides which of them are on the shelf.
 */
export type ConsoleServiceGroup = "Mobility" | "Self-service trips" | "Money" | "Trust & safety" | "Accommodation" | "Commerce" | "Account";

/** Display order of the groups in the service directory and the sidebar. */
export const CONSOLE_GROUP_ORDER: ConsoleServiceGroup[] = [
  "Mobility",
  "Self-service trips",
  "Money",
  "Trust & safety",
  "Accommodation",
  "Commerce",
  "Account",
];

export const consoleServices = [
  { id: "campus", title: "CampusRide", icon: CarFront, accent: "blue", group: "Mobility", href: "/console/campus", label: "CAMPUS OPERATIONS", description: "Keep campus moving.", detail: "Zones, routes, drivers, vehicles and ride queues.", action: "Open CampusRide", tags: ["Drivers & vehicles", "Zones & fares"], nav: [{ label: "Zones, drivers & queues", href: "/console/campus" }] },
  { id: "vacation", title: "VacationRide", icon: BusFront, accent: "orange", group: "Mobility", href: "/console/vacation", label: "TRIPS & PASSENGERS", description: "Every journey, organised.", detail: "Schedules, fares, passenger records and bookings.", action: "Manage trips", tags: ["Trip scheduler", "Passenger records"], nav: [{ label: "Schedules & bookings", href: "/console/vacation" }] },
  { id: "driver", title: "Driver portal", icon: MapPinned, accent: "green", group: "Mobility", href: "/console/driver", label: "BOARDING & QUEUES", description: "From pickup to arrival.", detail: "The driver workspace for today's queue and boarding.", action: "Open driver portal", tags: ["Driver access"], nav: [{ label: "Today's queue", href: "/console/driver" }] },
  { id: "organizers", title: "Organizer applications", icon: Store, accent: "orange", group: "Self-service trips", href: "/console/organizers", label: "SELF-SERVICE TRIPS", description: "Approve who publishes coaches.", detail: "Review applications, activate or suspend organizers, and assign trips to them.", action: "Review applications", tags: ["Applications", "Trip ownership"], nav: [{ label: "Applications", href: "/console/organizers" }] },
  { id: "organizer", title: "Organizer workspace", icon: BusFront, accent: "orange", group: "Self-service trips", href: "/console/trips", label: "MY TRIPS", description: "Your coaches and passengers.", detail: "The trips you own, their passenger manifests and your trip notice.", action: "Open workspace", tags: ["Trips", "Manifests"], nav: [{ label: "My trips", href: "/console/trips" }, { label: "Business profile", href: "/console/profile" }, { label: "Earnings", href: "/console/earnings" }] },
  { id: "profile", title: "Business profile", icon: IdCard, accent: "cyan", group: "Money", href: "/console/profile", label: "VERIFICATION & PAYOUTS", description: "Get verified, get paid.", detail: "Submit identity verification and the account your payouts should reach.", action: "Open profile", tags: ["KYC", "Payout account"], nav: [{ label: "Verification & payout account", href: "/console/profile" }] },
  { id: "earnings", title: "Earnings", icon: Wallet, accent: "cyan", group: "Money", href: "/console/earnings", label: "MY STATEMENT", description: "Every fare you earned.", detail: "See what each booking earned, what is ready to pay, and the payouts already recorded.", action: "Open statement", tags: ["Statement", "Payouts"], nav: [{ label: "Statement", href: "/console/earnings" }] },
  { id: "payouts", title: "Organizer payouts", icon: Banknote, accent: "green", group: "Money", href: "/console/payouts", label: "MONEY OUT", description: "Pay what the platform owes.", detail: "Balances per organizer, the accrual ledger, and recording a payout by transfer reference.", action: "Open payouts", tags: ["Ledger", "Batch payouts"], nav: [{ label: "Balances & batches", href: "/console/payouts" }] },
  { id: "disputes", title: "Disputes", icon: Scale, accent: "purple", group: "Trust & safety", href: "/console/disputes", label: "TRUST & RESOLUTION", description: "Decide what went wrong.", detail: "What passengers and organizers raised, and the record of what was decided and why.", action: "Open disputes", tags: ["Complaints", "Decisions"], nav: [{ label: "Cases", href: "/console/disputes" }] },
  { id: "hostels", title: "Hostel Finder", icon: BedDouble, accent: "green", group: "Accommodation", href: null, label: "ACCOMMODATION", description: "A home for every student.", detail: "Hostel management is not available yet.", action: "Coming soon", tags: [], nav: [] },
  { id: "food", title: "Food", icon: Utensils, accent: "peach", group: "Commerce", href: null, label: "CAMPUS DINING", description: "Something good is coming.", detail: "Vendor and order management is not available yet.", action: "Coming soon", tags: [], nav: [] },
  { id: "cinema", title: "OnlineCinema", icon: Clapperboard, accent: "purple", group: "Commerce", href: null, label: "ENTERTAINMENT", description: "A place for movie nights.", detail: "Cinema management is not available yet.", action: "Coming soon", tags: [], nav: [] },
  { id: "security", title: "Account security", icon: LockKeyhole, accent: "purple", group: "Account", href: "/console/change-password", label: "YOUR ACCESS", description: "Look after your access.", detail: "Change the password that opens this console.", action: "Change password", tags: ["Password settings"], nav: [{ label: "Password", href: "/console/change-password" }] },
] as const;

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
    MODERATOR: ["organizers", "disputes", "hostels", "security"],
    DRIVER: ["driver", "security"],
    ORGANIZER: ["organizer", "profile", "earnings", "disputes", "security"],
  };
  return (order[role] || ["security"]).flatMap((id) => consoleServices.filter((service) => service.id === id));
}

/** The role's services, grouped the way a product directory is grouped. */
export function consoleGroupsForRole(role: string) {
  const services = consoleServicesForRole(role);
  return CONSOLE_GROUP_ORDER
    .map((group) => ({ group, services: services.filter((service) => service.group === group) }))
    .filter((entry) => entry.services.length);
}

/** The first service of the role, used as the sidebar's fallback selection. */
export function consoleServiceById(id: string) {
  return consoleServices.find((service) => service.id === id) ?? null;
}
