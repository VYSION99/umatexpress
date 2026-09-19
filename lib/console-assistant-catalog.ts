import type { ConsoleRole } from "./console-auth";

/**
 * What the console assistant is allowed to know and do, as data.
 *
 * The catalogue is the contract between three things that must agree: the
 * model (which reads the descriptions), the API (which refuses a tool the
 * session's role does not hold) and the person (who sees the same titles in the
 * confirmation card). It is deliberately free of runtime imports so the tests
 * and the docs can read it directly.
 *
 * Two kinds of tool:
 *
 *   read   — the assistant runs it and answers from the result.
 *   action — the assistant may only propose it. The proposal is signed and
 *            handed to the person; nothing changes until they confirm, and the
 *            confirm endpoint re-checks the role before it executes.
 */

export type ConsoleAssistantToolKind = "read" | "action";

export type ConsoleAssistantToolParameter = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  enum?: readonly string[];
};

export type ConsoleAssistantTool = {
  /** OpenAI-style function name: letters, digits and underscores only. */
  name: string;
  title: string;
  description: string;
  kind: ConsoleAssistantToolKind;
  roles: readonly ConsoleRole[];
  parameters: readonly ConsoleAssistantToolParameter[];
};

const statusParameter = (description: string, values: readonly string[], required = false): ConsoleAssistantToolParameter => ({
  key: "status",
  label: "Status",
  type: "string",
  description,
  required,
  enum: values,
});

const reasonParameter: ConsoleAssistantToolParameter = {
  key: "reason",
  label: "Reason",
  type: "string",
  description: "Why, in one sentence. It is stored and shown to the person affected, so keep it factual.",
  required: false,
};

export const consoleAssistantTools: readonly ConsoleAssistantTool[] = [
  {
    name: "console_guide",
    title: "Console guide",
    description: "What this role can see and where each task lives in the console. Use it to answer how-do-I questions and to point at the right page.",
    kind: "read",
    roles: ["ADMIN", "MODERATOR", "ORGANIZER", "DRIVER"],
    parameters: [
      { key: "topic", label: "Topic", type: "string", description: "What the person is trying to do, in their own words.", required: false },
    ],
  },
  {
    name: "daily_brief",
    title: "Daily brief",
    description: "What needs this person's attention right now: the counts and items waiting on them, ordered by urgency, each with the page that handles it. Use it first for open questions like what needs attention or where to start.",
    kind: "read",
    roles: ["ADMIN", "MODERATOR", "ORGANIZER", "DRIVER"],
    parameters: [],
  },
  {
    name: "organizers_list",
    title: "Organizer applications",
    description: "Organizer applications and their review status. Use it to answer who applied, who is waiting, and who is active or suspended.",
    kind: "read",
    roles: ["ADMIN", "MODERATOR"],
    parameters: [statusParameter("Only return applications in this state.", ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"])],
  },
  {
    name: "trips_review_queue",
    title: "Trips awaiting review",
    description: "Organizer trips that are waiting for staff review. Use it before proposing a trip decision.",
    kind: "read",
    roles: ["ADMIN", "MODERATOR"],
    parameters: [],
  },
  {
    name: "payouts_balances",
    title: "Organizer balances",
    description: "Per-organizer accrued, ready and released payout totals, with commission and KYC state.",
    kind: "read",
    roles: ["ADMIN"],
    parameters: [],
  },
  {
    name: "disputes_list",
    title: "Disputes",
    description: "Open and recent disputes. Staff see every dispute; an organizer sees only the ones about their own trips.",
    kind: "read",
    roles: ["ADMIN", "MODERATOR", "ORGANIZER"],
    parameters: [statusParameter("Only return disputes in this state.", ["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"])],
  },
  {
    name: "campus_overview",
    title: "CampusRide overview",
    description: "Counts of zones, corridors, vehicles, drivers and live rides, plus anything that looks switched off.",
    kind: "read",
    roles: ["ADMIN"],
    parameters: [],
  },
  {
    name: "my_trips",
    title: "My trips",
    description: "The signed-in organizer's own trips with review state, bookings and seats.",
    kind: "read",
    roles: ["ORGANIZER"],
    parameters: [],
  },
  {
    name: "my_notice",
    title: "My trip notice",
    description: "The signed-in organizer's current passenger notice.",
    kind: "read",
    roles: ["ORGANIZER"],
    parameters: [],
  },
  {
    name: "my_earnings",
    title: "My earnings",
    description: "The signed-in organizer's payout totals and the most recent statement entries.",
    kind: "read",
    roles: ["ORGANIZER"],
    parameters: [],
  },
  {
    name: "driver_shift",
    title: "My shift",
    description: "The signed-in driver's profile, their open ride and the zones, corridors and vehicles on the platform.",
    kind: "read",
    roles: ["DRIVER"],
    parameters: [],
  },
  {
    name: "driver_queue",
    title: "My boarding queue",
    description: "The passengers waiting on the signed-in driver's ride, in queue order.",
    kind: "read",
    roles: ["DRIVER"],
    parameters: [],
  },
  {
    name: "organizers_review",
    title: "Review an organizer application",
    description: "Approve, reject or suspend an organizer application. Approval activates the organizer's console account; rejection requires a reason.",
    kind: "action",
    roles: ["ADMIN"],
    parameters: [
      { key: "organizerId", label: "Organizer id", type: "string", description: "The id from organizers_list.", required: true },
      { key: "action", label: "Decision", type: "string", description: "APPROVE activates the account, REJECT keeps it closed, SUSPEND takes it away.", required: true, enum: ["APPROVE", "REJECT", "SUSPEND"] },
      reasonParameter,
    ],
  },
  {
    name: "trips_review",
    title: "Review an organizer trip",
    description: "Approve, reject or suspend a trip that is waiting for review. The trip must be in the review queue.",
    kind: "action",
    roles: ["ADMIN", "MODERATOR"],
    parameters: [
      { key: "tripId", label: "Trip id", type: "string", description: "The id from trips_review_queue.", required: true },
      { key: "action", label: "Decision", type: "string", description: "APPROVE publishes the trip, REJECT sends it back, SUSPEND takes it off sale.", required: true, enum: ["APPROVE", "REJECT", "SUSPEND"] },
      reasonParameter,
    ],
  },
  {
    name: "disputes_resolve",
    title: "Resolve a dispute",
    description: "Record a decision on a dispute. Moving money is a separate act that this tool never performs.",
    kind: "action",
    roles: ["ADMIN", "MODERATOR"],
    parameters: [
      { key: "disputeId", label: "Dispute id", type: "string", description: "The id from disputes_list.", required: true },
      { key: "status", label: "Status", type: "string", description: "RESOLVED closes the case; REVIEWING records that it is being looked into.", required: true, enum: ["RESOLVED", "REVIEWING"] },
      { key: "resolution", label: "Outcome", type: "string", description: "What was decided, for the record.", required: false, enum: ["REFUND", "PARTIAL_REFUND", "REPLACEMENT", "NO_ACTION", "OTHER"] },
      { key: "note", label: "Note", type: "string", description: "What was decided and why. Required when the case is resolved.", required: true },
    ],
  },
  {
    name: "notice_update",
    title: "Update my trip notice",
    description: "Change the passenger notice shown with the signed-in organizer's trips. Only the fields being changed need to be given.",
    kind: "action",
    roles: ["ORGANIZER"],
    parameters: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Whether the notice is shown at all.", required: false },
      { key: "title", label: "Title", type: "string", description: "Headline of the notice.", required: false },
      { key: "route", label: "Route", type: "string", description: "Route the notice is about.", required: false },
      { key: "fare", label: "Fare", type: "string", description: "Fare text, exactly as passengers should read it.", required: false },
    ],
  },
];

export function consoleAssistantToolByName(name: string): ConsoleAssistantTool | null {
  return consoleAssistantTools.find((tool) => tool.name === name) || null;
}

export function consoleAssistantToolsForRole(role: string): readonly ConsoleAssistantTool[] {
  return consoleAssistantTools.filter((tool) => (tool.roles as readonly string[]).includes(role));
}

export function consoleAssistantToolNamesForRole(role: string): readonly string[] {
  return consoleAssistantToolsForRole(role).map((tool) => tool.name);
}
