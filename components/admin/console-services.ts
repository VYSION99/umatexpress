import { Bed, Bus, Car, FilmSlate, ForkKnife, IdentificationCard, LockKey, MapPinLine, Money, Scales, SlidersHorizontal, Storefront, UsersThree, Wallet, UserCircle } from "../ui/MaterialIcon.ts";
// The shared icon type keeps service metadata usable in both server and client views.
import type { Icon } from "../ui/MaterialIcon.ts";

/**
 * The console is one console for every UMaTeXPRESS service, the way a cloud
 * console is one console for every product. A service is a product area with
 * its own navigation; a role decides which of them are on the shelf.
 */
export type ConsoleServiceGroup = "Transport" | "Accommodation" | "Finance" | "Trust & safety" | "Entertainment" | "Campus services" | "Administration" | "Account";

/** One page inside a service. `roles` restricts it to some of the roles that see the service. */
export type ConsoleServiceNavItem = { label: string; href: string; roles?: readonly string[] };

export type ConsoleService = {
  id: string;
  title: string;
  icon: Icon;
  accent: string;
  group: ConsoleServiceGroup;
  href: string;
  label: string;
  description: string;
  detail: string;
  action: string;
  tags: readonly string[];
  nav: readonly ConsoleServiceNavItem[];
  /** Unmarked administrator services are assignable to delegates by default. */
  adminAccess?: "personal" | "owner-only" | "account";
  /** Additional API roots for a service whose endpoints predate its catalog ID. */
  delegateRoutes?: readonly string[];
};

/** Display order of the groups in the service directory and the sidebar. */
export const CONSOLE_GROUP_ORDER: ConsoleServiceGroup[] = [
  "Transport", "Accommodation", "Finance", "Trust & safety",
  "Entertainment", "Campus services", "Administration", "Account",
];

export const consoleServices: readonly ConsoleService[] = [
  { id: "campus", title: "CampusRide", icon: Car, accent: "blue", group: "Transport", href: "/console/campus", label: "CAMPUS OPERATIONS", description: "Keep campus moving.", detail: "Zones, routes, drivers, vehicles and ride queues.", action: "Open CampusRide", tags: ["Drivers & vehicles", "Zones & fares"], nav: [{ label: "Zones, drivers & queues", href: "/console/campus" }], delegateRoutes: ["/api/admin/campus", "/api/v1/campus/admin"] },
  { id: "vacation", title: "VacationRide", icon: Bus, accent: "orange", group: "Transport", href: "/console/vacation", label: "TRIPS & PASSENGERS", description: "Every journey, organised.", detail: "Schedules, fares, passenger records and bookings.", action: "Manage trips", tags: ["Trip scheduler", "Passenger records"], nav: [{ label: "Schedules & bookings", href: "/console/vacation" }], delegateRoutes: ["/api/console/trips", "/api/admin/bookings", "/api/trips/schedule", "/api/trips/display", "/api/admin/ai"] },
  { id: "driver", adminAccess: "personal", title: "Driver portal", icon: MapPinLine, accent: "green", group: "Transport", href: "/console/driver", label: "BOARDING & QUEUES", description: "From pickup to arrival.", detail: "The driver workspace for today's queue and boarding.", action: "Open driver portal", tags: ["Driver access"], nav: [{ label: "Today's queue", href: "/console/driver" }] },
  { id: "organizers", title: "Organizer applications", icon: Storefront, accent: "orange", group: "Transport", href: "/console/organizers", label: "SELF-SERVICE TRIPS", description: "Review trip organizer applications.", detail: "Review applications, activate or suspend organizers, and assign trips to them.", action: "Review applications", tags: ["Applications", "Trip ownership"], nav: [{ label: "Applications", href: "/console/organizers" }] },
  { id: "organizer", adminAccess: "personal", title: "Organizer workspace", icon: Bus, accent: "orange", group: "Transport", href: "/console/trips", label: "MY TRIPS", description: "Your trips and passengers.", detail: "Manage your trips, passenger lists and announcements.", action: "Open workspace", tags: ["Trips", "Manifests"], nav: [{ label: "My trips", href: "/console/trips" }, { label: "Business profile", href: "/console/profile" }, { label: "Earnings", href: "/console/earnings" }] },
  { id: "profile", adminAccess: "personal", title: "Business profile", icon: IdentificationCard, accent: "cyan", group: "Finance", href: "/console/profile", label: "VERIFICATION & PAYOUTS", description: "Get verified, get paid.", detail: "Submit identity verification and the account your payouts should reach.", action: "Open profile", tags: ["KYC", "Payout account"], nav: [{ label: "Verification & payout account", href: "/console/profile" }] },
  { id: "earnings", adminAccess: "personal", title: "Earnings", icon: Wallet, accent: "cyan", group: "Finance", href: "/console/earnings", label: "MY STATEMENT", description: "Every fare you earned.", detail: "See what each booking earned, what is ready to pay, and the payouts already recorded.", action: "Open statement", tags: ["Statement", "Payouts"], nav: [{ label: "Statement", href: "/console/earnings" }] },
  { id: "finance", title: "Payment operations", icon: Money, accent: "green", group: "Finance", href: "/console/finance", label: "PAYMENTS & ACCOUNTING", description: "Reconcile payments and recover exceptions.", detail: "Review balances, payment outcomes and settlement differences.", action: "Open payment operations", tags: ["Accounting", "Reconciliation"], nav: [{ label: "Payment operations", href: "/console/finance" }] },
  { id: "payouts", title: "Organizer payouts", icon: Money, accent: "green", group: "Finance", href: "/console/payouts", label: "MONEY OUT", description: "Pay what the platform owes.", detail: "Review organizer balances and manage payouts.", action: "Open payouts", tags: ["Ledger", "Batch payouts", "Transfer authorisation"], nav: [{ label: "Balances & batches", href: "/console/payouts" }] },
  { id: "disputes", title: "Disputes", icon: Scales, accent: "purple", group: "Trust & safety", href: "/console/disputes", label: "TRUST & RESOLUTION", description: "Decide what went wrong.", detail: "Review reported problems and record decisions.", action: "Open disputes", tags: ["Complaints", "Decisions"], nav: [{ label: "Cases", href: "/console/disputes" }] },
  { id: "hostels", title: "Hostel Finder", icon: Bed, accent: "green", group: "Accommodation", href: "/console/hostels", label: "ACCOMMODATION", description: "A home for every student.", detail: "Manage properties, rooms, bed spaces, residents and services.", action: "Open workspace", tags: ["Properties", "Residents & services"], nav: [{ label: "Setup & verification", href: "/console/hostels/onboarding", roles: ["LANDLORD"] }, { label: "Properties", href: "/console/hostels" }, { label: "Staff guide", href: "/console/hostels/guide", roles: ["LANDLORD", "ADMIN", "MODERATOR"] }, { label: "Residents & services", href: "/console/hostels/residents", roles: ["LANDLORD"] }, { label: "Reviews", href: "/console/hostels/reviews", roles: ["LANDLORD", "ADMIN", "MODERATOR"] }, { label: "Payouts", href: "/console/hostels/payouts", roles: ["ADMIN"] }, { label: "Refunds", href: "/console/hostels/refunds", roles: ["ADMIN"] }, { label: "Service catalogue", href: "/console/hostels/plugins", roles: ["ADMIN"] }, { label: "Analytics", href: "/console/hostels/analytics", roles: ["ADMIN"] }, { label: "Supply signals", href: "/console/hostels/signals", roles: ["ADMIN", "MODERATOR"] }], delegateRoutes: ["/api/console/hostel", "/api/admin/hostel"] },
  { id: "cinema", title: "OnlineCinema", icon: FilmSlate, accent: "purple", group: "Entertainment", href: "/console/cinema", label: "ENTERTAINMENT · WATCH", description: "Manage shared watch rooms.", detail: "Manage watch rooms, participants and student reports.", action: "Open rooms", tags: ["Watch rooms", "Student reports"], nav: [{ label: "Rooms", href: "/console/cinema" }, { label: "Reports", href: "/console/cinema/signals" }] },
  { id: "food", title: "Food operations", icon: ForkKnife, accent: "green", group: "Campus services", href: "/console/food", label: "CAMPUS FOOD · DIRECTORY", description: "Publish only what providers confirm.", detail: "Manage food providers, menus, orders and student reports.", action: "Manage directory", tags: ["Provider checks", "Menus & corrections"], nav: [{ label: "Providers, orders & reports", href: "/console/food" }] },
  { id: "print-copy", title: "Print & Copy", icon: Storefront, accent: "green", group: "Campus services", href: "/console/print-copy", label: "CAMPUS SERVICES · PRINT", description: "Keep shop details current and reviewed.", detail: "Manage verified print shops, student quote requests and listing corrections.", action: "Manage print shops", tags: ["Provider checks", "Quote requests"], nav: [{ label: "Shops & requests", href: "/console/print-copy" }] },
  { id: "settings", title: "Platform settings", icon: SlidersHorizontal, accent: "cyan", group: "Administration", href: "/console/settings", label: "PLATFORM · CONTROLS", description: "Manage platform controls.", detail: "Manage payout automation, fees and service limits.", action: "Open settings", tags: ["Payout automation", "Fees & minimums"], nav: [{ label: "Payout automation", href: "/console/settings" }], delegateRoutes: ["/api/console/bindings"] },
  { id: "delegates", adminAccess: "owner-only", title: "Team access", icon: UsersThree, accent: "blue", group: "Administration", href: "/console/delegates", label: "TEAM ACCESS", description: "Give each teammate only the console services they manage.", detail: "Manage team accounts and service permissions. Access changes end active sessions.", action: "Manage team access", tags: ["Service permissions", "Access control"], nav: [{ label: "Delegate accounts", href: "/console/delegates" }] },
  { id: "account", adminAccess: "account", title: "My account", icon: UserCircle, accent: "green", group: "Account", href: "/console/account", label: "YOUR ACCOUNT", description: "Your account in one place.", detail: "Edit console contact details and open your security and service settings.", action: "Open profile", tags: ["Profile", "Account settings"], nav: [{ label: "Profile & security", href: "/console/account" }] },
  { id: "security", adminAccess: "account", title: "Change password", icon: LockKey, accent: "purple", group: "Account", href: "/console/change-password", label: "YOUR ACCESS", description: "Look after your access.", detail: "Update your console password.", action: "Change password", tags: ["Password settings"], nav: [{ label: "Password", href: "/console/change-password" }] },
];

/** The pages of a service this role may actually open. */
export function consoleServiceNavForRole(service: ConsoleService, role: string) {
  return service.nav.filter((entry) => !entry.roles || entry.roles.includes(role));
}

/**
 * Services that belong to the person doing that work and never to an
 * administrator: a driver's own queue, and the trips, verification and earnings
 * of one organizer. Every one of those pages refuses a staff account, so
 * offering them to an admin would be a row of dead ends.
 */
/** A new administrator service becomes assignable as soon as it joins the catalog. */
export function delegatableServicesFromCatalog(catalog: readonly ConsoleService[]) {
  return catalog.filter((service) => service.adminAccess === undefined);
}

export const delegatableConsoleServices = delegatableServicesFromCatalog(consoleServices);

export function delegateServiceForCatalogPath(pathname: string, services: readonly ConsoleService[] = delegatableConsoleServices): string | null {
  for (const service of services) {
    const roots = [service.href, `/api/console/${service.id}`, ...(service.delegateRoutes || [])];
    if (roots.some((root) => pathname === root || pathname.startsWith(`${root}/`))) return service.id;
  }
  return null;
}

/**
 * One console, four roles. A service is only offered to the roles that may use
 * it, and this list is presentation only: the matching API re-checks the role
 * from the signed session on every request.
 */
export function consoleServicesForRole(role: string, delegateServices?: readonly string[]) {
  if (role === "ADMIN") return consoleServices.filter((service) => service.adminAccess !== "personal" && (delegateServices === undefined || service.adminAccess === "account" || (service.adminAccess !== "owner-only" && delegateServices.includes(service.id))));
  // Role order matters: the role's own workspace leads and account security is
  // always last, so the first card is the one the person signed in to use.
  const order: Record<string, string[]> = {
    MODERATOR: ["organizers", "disputes", "hostels", "cinema", "food", "account", "security"],
    LANDLORD: ["hostels", "account", "security"],
    DRIVER: ["driver", "account", "security"],
    ORGANIZER: ["organizer", "profile", "earnings", "disputes", "account", "security"],
    VENDOR: ["food", "account", "security"],
    CINEMA: ["cinema", "account", "security"],
  };
  return (order[role] || ["account", "security"]).flatMap((id) => consoleServices.filter((service) => service.id === id));
}

/** The role's services, grouped the way a product directory is grouped. */
export function consoleGroupsForRole(role: string, delegateServices?: readonly string[]) {
  const services = consoleServicesForRole(role, delegateServices);
  return CONSOLE_GROUP_ORDER
    .map((group) => ({ group, services: services.filter((service) => service.group === group) }))
    .filter((entry) => entry.services.length);
}

/** The first service of the role, used as the sidebar's fallback selection. */
export function consoleServiceById(id: string) {
  return consoleServices.find((service) => service.id === id) ?? null;
}
