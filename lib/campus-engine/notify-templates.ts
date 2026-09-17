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
 */
export function ticketUrl(reference: string, origin?: string) {
  const base = String(origin || "").trim().replace(/\/$/, "");
  if (!base || !reference) return "";
  return `${base}/campus/ticket?reference=${encodeURIComponent(reference)}`;
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
