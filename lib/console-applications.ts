import type { ConsoleRole } from "./console-auth";

/**
 * Joining the console. The console is one account for every service, but the
 * way in differs by what a person will do, so this module is the single
 * description of every way in: the services a stranger may apply for, and the
 * operational roles that are set up by the team that runs them.
 *
 * The description is deliberately free of runtime imports — only a type — so
 * the API, the pages and the tests all share it without pulling a database or
 * a React tree along.
 */

export type ConsoleApplicationStatus = "OPEN" | "COMING_SOON";

/**
 * REVIEW — the account cannot sign in until a reviewer approves it, which is
 *          how a stranger must be treated before they can sell anything.
 * DIRECT — the account signs in at once so its owner can build drafts and
 *          profile; publishing, payouts and visibility stay behind review.
 */
export type ConsoleApplicationActivation = "REVIEW" | "DIRECT";

export type ConsoleApplicationField = {
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "password";
  autoComplete?: string;
  required: boolean;
  hint?: string;
};

export type ConsoleApplication = {
  id: string;
  /** The console role an approved application becomes; null while the service is not built. */
  role: ConsoleRole | null;
  title: string;
  short: string;
  /** One line for the picker card. */
  blurb: string;
  /** What the form promises before it is filled in. */
  detail: string;
  applyLabel: string;
  status: ConsoleApplicationStatus;
  activation: ConsoleApplicationActivation;
  /** The console service whose team reviews the application. */
  reviewService: string;
  endpoint: string;
  fields: readonly ConsoleApplicationField[];
};

const passwordField = (minimum: number): ConsoleApplicationField => ({
  key: "password",
  label: "Password",
  type: "password",
  autoComplete: "new-password",
  required: true,
  hint: `Use at least ${minimum} characters with an uppercase letter, a lowercase letter, a number and a symbol.`,
});

const contactFields: readonly ConsoleApplicationField[] = [
  { key: "name", label: "Full name", type: "text", autoComplete: "name", required: true },
  { key: "phone", label: "Phone number", type: "tel", autoComplete: "tel", required: true },
  { key: "email", label: "Email address", type: "email", autoComplete: "email", required: true },
];

/**
 * Every service someone may apply for. An application never mints an
 * operational role: a driver or a moderator is set up by the team that runs
 * them (see `consoleInvitedAccess`), or the apply page would be a way to
 * promote yourself.
 */
export const consoleApplications: readonly ConsoleApplication[] = [
  {
    id: "organizer",
    role: "ORGANIZER",
    title: "Organise your coach",
    short: "Trip organizer",
    blurb: "Publish vacationRide trips and sell seats.",
    detail: "Apply to publish trips on vacationRide. An administrator reviews every application before your account can sign in.",
    applyLabel: "Apply to organise",
    status: "OPEN",
    activation: "REVIEW",
    reviewService: "organizers",
    endpoint: "/api/console/applications/organizer",
    fields: [
      contactFields[0],
      { key: "organization", label: "Organisation (shown to students)", type: "text", autoComplete: "organization", required: false },
      contactFields[1],
      contactFields[2],
      passwordField(10),
    ],
  },
  {
    id: "landlord",
    role: "LANDLORD",
    title: "List your hostel",
    short: "Hostel landlord",
    blurb: "Put rooms and bed-spaces in front of students.",
    detail: "Register to list hostels on Hostel Finder. You can build your property and beds right away; every listing goes live only after a review.",
    applyLabel: "Open a landlord account",
    status: "OPEN",
    activation: "DIRECT",
    reviewService: "hostels",
    endpoint: "/api/console/applications/landlord",
    fields: [
      contactFields[0],
      { key: "organization", label: "Hostel or business name (optional)", type: "text", autoComplete: "organization", required: false },
      contactFields[1],
      contactFields[2],
      passwordField(10),
    ],
  },
  {
    id: "vendor",
    role: null,
    title: "Sell on campus",
    short: "Food vendor",
    blurb: "Take campus dining orders.",
    detail: "Opens with the Food service. Vendors register, build a menu and go live after a review.",
    applyLabel: "Apply to sell",
    status: "COMING_SOON",
    activation: "DIRECT",
    reviewService: "food",
    endpoint: "/api/console/applications/vendor",
    fields: [...contactFields, passwordField(10)],
  },
  {
    id: "cinema",
    role: null,
    title: "Host a screen",
    short: "Cinema partner",
    blurb: "Publish showings for movie nights.",
    detail: "Opens with OnlineCinema. Partners register, add showings and go live after a review.",
    applyLabel: "Apply to host",
    status: "COMING_SOON",
    activation: "DIRECT",
    reviewService: "cinema",
    endpoint: "/api/console/applications/cinema",
    fields: [...contactFields, passwordField(10)],
  },
];

/**
 * The application programmes a server can actually process. A programme may be
 * OPEN while its handler is still being built — the API answers 501 instead of
 * pretending — but this list and the OPEN status must agree the day it ships.
 */
export const implementedConsoleApplicationIds: readonly string[] = ["organizer", "landlord"];

export function consoleApplicationById(id: string): ConsoleApplication | null {
  return consoleApplications.find((application) => application.id === id) || null;
}

export function openConsoleApplications(): readonly ConsoleApplication[] {
  return consoleApplications.filter((application) => application.status === "OPEN");
}

export function consoleApplicationRequiredFields(application: ConsoleApplication): readonly ConsoleApplicationField[] {
  return application.fields.filter((field) => field.required);
}

/** Access that is never self-service: the team that runs a service sets it up. */
export type ConsoleInvitedAccess = {
  id: string;
  roles: readonly ConsoleRole[];
  title: string;
  detail: string;
  contact: string;
};

export const consoleInvitedAccess: readonly ConsoleInvitedAccess[] = [
  {
    id: "driver",
    roles: ["DRIVER"],
    title: "CampusRide driver",
    detail: "Drivers are added by CampusRide operations together with their vehicle, zone and corridor. There is no public driver sign-up.",
    contact: "Ask CampusRide operations to add you to a vehicle and zone.",
  },
  {
    id: "staff",
    roles: ["ADMIN", "MODERATOR"],
    title: "Platform staff",
    detail: "Administrator and moderator accounts are created by an administrator. The console never appoints itself.",
    contact: "Ask an administrator to create your account.",
  },
];
