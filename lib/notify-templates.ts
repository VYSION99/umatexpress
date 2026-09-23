import { queueNotification } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";
import { ensureNotificationsTable, isTursoConfiguredRuntime, turso } from "@/lib/turso";

/**
 * The two-party notice book.
 *
 * Every service on the platform has a pair of parties in it: a provider and
 * the platform (an application is approved, a KYC check decides whether money
 * may leave), or a buyer and a provider (a seat is confirmed, a refund is
 * decided, a payout is sent). The outbox already carries all of them — one row
 * is both the email and the in-app record, and the unique `(reference,
 * template)` index makes a repeated decision send once — but each service was
 * building its own copy, and the decision notices were missing altogether: an
 * approved organizer was never told.
 *
 * This module is the one place that copy lives. A service picks its `kind`,
 * the decision it just made, and a few facts; the wording, the template id and
 * the reference key come from here, so the same decision reads the same way in
 * every product.
 *
 * The template id is `<kind>_<subject>_<decision>`, lower-cased, which keeps
 * the existing convention (`hostel_refund_decided`, `vacation_booking_confirmed`)
 * and lets the sender route a link by prefix without a URL column.
 */

export type ProviderKind = "organizer" | "landlord" | "driver" | "vendor";

/** The account decision an administrator makes about a provider. */
export type ProviderDecision = "APPROVE" | "REJECT" | "SUSPEND";

/** The identity check that decides whether money may leave. */
export type KycDecision = "VERIFY" | "REJECT";

/** `APPROVE` reads as `approved` so an id describes what happened, not the button. */
const DECISION_TENSE: Record<ProviderDecision, string> = { APPROVE: "approved", REJECT: "rejected", SUSPEND: "suspended" };

export type PartyNotice = { template: string; subject: string; message: string };

export type ProviderCopy = {
  /** What the applicant is, in the words a message should use. */
  label: string;
  /** The product they applied to. */
  service: string;
  /** What one bookable thing they publish is called, for a listing decision. */
  offer: string;
  /** Where a provider signs in. */
  consolePath: string;
  /** What they should do first once approved. */
  nextStep: string;
};

export const PROVIDER_COPY: Record<ProviderKind, ProviderCopy> = {
  organizer: {
    label: "trip organizer",
    service: "vacationRide",
    offer: "trip",
    consolePath: "/console/login",
    nextStep: "Save your mobile money payout account so trip earnings can reach you, then publish your first trip.",
  },
  landlord: {
    label: "landlord",
    service: "Hostel Finder",
    offer: "listing",
    consolePath: "/console/login",
    nextStep: "Add your property and its rooms, then submit them for review so residents can find them.",
  },
  driver: {
    label: "driver",
    service: "campusRide",
    offer: "ride",
    consolePath: "/console/login",
    nextStep: "Once operations assigns your vehicle and zone, go online to start taking a queue.",
  },
  vendor: {
    label: "vendor",
    service: "UMaTeXPRESS",
    offer: "listing",
    consolePath: "/console/login",
    nextStep: "Complete your service details so students can order from you.",
  },
};

/** One tidy sentence: collapse whitespace and keep a reason to one line. */
function clean(value: unknown, limit = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * The id for one account decision. `APPROVE` reads as `approved` so the id
 * describes what happened, not the button that was pressed.
 */
export function providerDecisionTemplate(kind: ProviderKind, decision: ProviderDecision) {
  return `${kind}_application_${DECISION_TENSE[decision]}`;
}

export function providerKycTemplate(kind: ProviderKind, decision: KycDecision) {
  return `${kind}_kyc_${decision === "VERIFY" ? "verified" : "rejected"}`;
}

/**
 * The decision about one thing a provider publishes — a trip, a bed listing —
 * which is the second gate on them and is kept apart from the account: an
 * account decision changes whether someone may sell at all, this one changes
 * whether one thing they sell is visible. The two never share a template id, so
 * a provider reading one notice can tell which decision it describes.
 */
export function providerListingTemplate(kind: ProviderKind, decision: ProviderDecision) {
  return `${kind}_listing_${DECISION_TENSE[decision]}`;
}

export type ProviderDecisionContext = {
  /** The reason an administrator gave. Required for a rejection, optional otherwise. */
  reason?: unknown;
  /** Where the provider signs in. The console host is added by the sender. */
  loginUrl?: string;
};

/**
 * The account decision, in the applicant's words.
 *
 * A rejection always carries the reason an administrator was made to give
 * (`setOrganizerStatus` refuses a rejection without one), because "not
 * approved" with no reason is a dead end for the person reading it. A
 * suspension says the sign-in is closed, since that is the part they will
 * notice first.
 */
export function providerDecisionNotice(
  kind: ProviderKind,
  decision: ProviderDecision,
  context: ProviderDecisionContext = {},
): PartyNotice {
  const copy = PROVIDER_COPY[kind];
  const reason = clean(context.reason);
  const login = clean(context.loginUrl);
  const template = providerDecisionTemplate(kind, decision);
  const where = login ? ` Sign in at ${login}.` : ` Sign in at the console.`;

  if (decision === "APPROVE") {
    return {
      template,
      subject: `You are approved as a ${copy.service} ${copy.label}`,
      message: `Your ${copy.service} ${copy.label} application has been approved.${where} ${copy.nextStep}`,
    };
  }
  if (decision === "REJECT") {
    return {
      template,
      subject: `Your ${copy.service} ${copy.label} application needs changes`,
      message: `Your ${copy.service} ${copy.label} application was not approved yet.${reason ? ` Reason: ${reason}.` : ""} Fix that and apply again — nothing else is needed.`,
    };
  }
  return {
    template,
    subject: `Your ${copy.service} ${copy.label} account is suspended`,
    message: `Your ${copy.service} ${copy.label} account has been suspended${reason ? `: ${reason}.` : "."} Sign-in is closed and anything live is paused. Reply to this email if you think that is wrong.`,
  };
}

/**
 * The identity check. It is a separate gate from approval and it is the one a
 * payout waits on, so a verified provider is told payments can now be sent and
 * a rejected one is told exactly what to correct.
 */
export function providerKycNotice(
  kind: ProviderKind,
  decision: KycDecision,
  context: { reason?: unknown } = {},
): PartyNotice {
  const copy = PROVIDER_COPY[kind];
  const reason = clean(context.reason);
  const template = providerKycTemplate(kind, decision);
  if (decision === "VERIFY") {
    return {
      template,
      subject: `Your ${copy.service} payout details are verified`,
      message: `Your identity check for ${copy.service} is complete, so payments can be sent to your payout account. Keep your account details up to date — changing them starts a new check.`,
    };
  }
  return {
    template,
    subject: `We could not verify your ${copy.service} details`,
    message: `We could not verify the identity details on your ${copy.service} account${reason ? `: ${reason}.` : "."} Save them again with a clear copy of the document and the check will run again.`,
  };
}

export type ProviderListingContext = {
  /** The trip or listing that was decided on, named the way the provider named it. */
  listing?: unknown;
  /** The reason a reviewer gave. Required for a rejection, optional otherwise. */
  reason?: unknown;
};

/**
 * The listing decision, in the provider's words.
 *
 * An approval is the good news and says so, because the listing going live is
 * the moment the provider was waiting for. A rejection goes back as a draft —
 * nothing is lost and they can fix it — while a suspension is the platform
 * taking a live listing down, so it says the listing stays hidden until the
 * team lifts it, which is the part they would otherwise keep guessing about.
 */
export function providerListingNotice(
  kind: ProviderKind,
  decision: ProviderDecision,
  context: ProviderListingContext = {},
): PartyNotice {
  const copy = PROVIDER_COPY[kind];
  const listing = clean(context.listing, 120) || `your ${copy.offer}`;
  const reason = clean(context.reason);
  const template = providerListingTemplate(kind, decision);

  if (decision === "APPROVE") {
    return {
      template,
      subject: `Your ${copy.service} ${copy.offer} is live`,
      message: `${listing} is approved and live on ${copy.service}, so students can find and book it. Keep your identity check up to date so payouts on it are not held up.`,
    };
  }
  if (decision === "REJECT") {
    return {
      template,
      subject: `Your ${copy.service} ${copy.offer} needs changes`,
      message: `${listing} was sent back for changes${reason ? `: ${reason}.` : "."} Open your console, fix that and submit it again — it is still yours and nothing else is needed.`,
    };
  }
  return {
    template,
    subject: `Your ${copy.service} ${copy.offer} has been suspended`,
    message: `${listing} has been taken down${reason ? `: ${reason}.` : "."} It stays hidden from students until our team lifts the suspension. Reply to this email if you think that is wrong.`,
  };
}

/**
 * Every two-party notice the platform sends, in one list: the decision notices
 * above, plus the ones each service already sends for the money it moves. It
 * is a reference, not a gate — a service that is not listed here yet can still
 * queue its own row.
 */
export const PARTY_TEMPLATES = {
  providerDecision: (kind: ProviderKind, decision: ProviderDecision) => providerDecisionTemplate(kind, decision),
  providerKyc: (kind: ProviderKind, decision: KycDecision) => providerKycTemplate(kind, decision),
  providerListing: (kind: ProviderKind, decision: ProviderDecision) => providerListingTemplate(kind, decision),
  /** Buyer ↔ provider, already sent by the products that own them. */
  existing: {
    vacation_booking_confirmed: "Passenger: the seat is paid for and confirmed",
    vacation_booking_cancelled: "Passenger: a paid booking was cancelled",
    hostel_booking_confirmed: "Resident: the bed is paid for and confirmed",
    hostel_booking_landlord: "Landlord: a resident has paid",
    hostel_refund_requested: "Landlord: a resident asked for a refund",
    hostel_refund_decided: "Resident: the refund was approved, sent or declined",
    hostel_review_received: "Landlord: a resident left a review",
    hostel_review_replied: "Resident: the landlord replied",
    hostel_message_received: "Either party: a new message in the thread",
    hostel_payout_recorded: "Landlord: a payout was sent",
    driver_accepted: "Passenger: a driver accepted the queue entry",
    driver_arrived: "Passenger: the driver is at the pickup zone",
    trip_completed: "Passenger: the campusRide trip is complete",
    driver_cancelled: "Passenger: the driver cancelled the pickup",
  } as Record<string, string>,
};

/**
 * Queues one two-party notice.
 *
 * It never throws: every caller is a decision that has already been committed
 * to the database, and a messaging failure must not turn a recorded decision
 * into an error the administrator sees. The outbox is the record, so a failure
 * is logged and the message is simply not sent.
 */
export async function notifyParty(input: {
  recipient: unknown;
  reference: unknown;
  notice: PartyNotice;
}): Promise<{ status: "QUEUED" | "ALREADY_QUEUED" | "SKIPPED" | "FAILED"; reason?: string }> {
  const recipient = clean(input.recipient, 200).toLowerCase();
  const reference = clean(input.reference, 200);
  if (!recipient || !recipient.includes("@")) return { status: "SKIPPED", reason: "NO_RECIPIENT" };
  if (!reference) return { status: "SKIPPED", reason: "NO_REFERENCE" };
  try {
    if (!(await isTursoConfiguredRuntime())) return { status: "SKIPPED", reason: "TURSO_NOT_CONFIGURED" };
    await ensureNotificationsTable();
    const queued = await queueNotification(turso, {
      recipient,
      template: input.notice.template,
      subject: input.notice.subject,
      message: input.notice.message,
      reference,
      nowIso: new Date().toISOString(),
    });
    return queued ? { status: "QUEUED" } : { status: "ALREADY_QUEUED" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    logEvent("error", "party_notice_failed", { template: input.notice.template, reference, reason });
    return { status: "FAILED", reason };
  }
}
