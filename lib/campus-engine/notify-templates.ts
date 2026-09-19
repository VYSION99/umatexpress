export type CampusNotifyTemplate = "driver_accepted" | "driver_arrived" | "trip_completed" | "driver_cancelled";

export type CampusNotifyContext = {
  driverName: string;
  queuePosition: number;
};

/** The inbox line for each template, so the subject and the body agree. */
export const CAMPUS_NOTIFY_SUBJECTS: Record<CampusNotifyTemplate, string> = {
  driver_accepted: "Your campusRide driver is on the way",
  driver_arrived: "Your campusRide driver has arrived",
  trip_completed: "Your campusRide trip is complete",
  driver_cancelled: "Your campusRide ride was cancelled",
};

/**
 * Where a passenger follows one ticket. Kept out of the message itself: the
 * in-app feed answers "what happened" on its own, and only the email needs a
 * clickable line, so the link is added by the sender rather than stored.
 *
 * `path` is the ticket page, which differs per product: campusRide checks a
 * queue PIN, vacationRide shows a boarding pass. The template's prefix decides
 * which one the sender uses, so the outbox needs no URL column.
 */
export function ticketUrl(reference: string, origin?: string, path = "/campus/ticket") {
  const base = String(origin || "").trim().replace(/\/$/, "");
  if (!base || !reference) return "";
  return `${base}${path}?reference=${encodeURIComponent(reference)}`;
}

/** Which product's ticket a template points at: the prefix decides. */
export function ticketKindForTemplate(template: string): "vacation" | "campus" {
  return String(template || "").startsWith("vacation_") ? "vacation" : "campus";
}

/** The ticket page and link wording for a notification template. */
export function ticketLinkForTemplate(template: string): { path: string; cta: string } {
  return ticketKindForTemplate(template) === "vacation"
    ? { path: "/payment/callback", cta: "View your ticket" }
    : { path: "/campus/ticket", cta: "Track your ride" };
}

/**
 * Passenger-facing message for one queue transition. The boarding PIN is never
 * included: these messages leave the device and may be read by others.
 */
export function campusNotification(template: CampusNotifyTemplate, context: CampusNotifyContext) {
  const driver = context.driverName || "Your campusRide driver";
  if (template === "driver_accepted") {
    return { title: "Driver accepted", message: `${driver} accepted you (queue #${context.queuePosition}) and is on the way to you.` };
  }
  if (template === "driver_arrived") {
    return { title: "Driver arrived", message: `${driver} has arrived at your pickup zone. Have your boarding PIN ready.` };
  }
  if (template === "trip_completed") {
    return { title: "Trip completed", message: `Your trip with ${driver} is complete. Thanks for riding!` };
  }
  return { title: "Ride cancelled", message: `${driver} cancelled your pickup. Join the queue again for another ride.` };
}

/** Queue status that triggers a passenger notification, if any. */
export const CAMPUS_NOTIFY_BY_STATUS: Record<string, CampusNotifyTemplate> = {
  ACCEPTED_BY_DRIVER: "driver_accepted",
  DRIVER_ARRIVED: "driver_arrived",
  COMPLETED: "trip_completed",
  CANCELLED_BY_DRIVER: "driver_cancelled",
};
