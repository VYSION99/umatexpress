import { cedis } from "@/lib/campus-fare-math";

export type CampusNotifyTemplate =
  | "driver_accepted"
  | "driver_arrived"
  | "trip_completed"
  | "driver_cancelled"
  | "campus_cancelled"
  | "campus_no_ride"
  | "campus_ride_ended"
  | "campus_refund_declined"
  | "campus_seats_open";

export type CampusNotifyContext = {
  driverName: string;
  queuePosition: number;
  /** A refund's amount, in pesewas, when the message is about money coming back. */
  amount?: number;
  /** How long the platform waited for a driver before refunding, in minutes. */
  windowMinutes?: number;
};

/** The inbox line for each template, so the subject and the body agree. */
export const CAMPUS_NOTIFY_SUBJECTS: Record<CampusNotifyTemplate, string> = {
  driver_accepted: "Your campusRide driver is on the way",
  driver_arrived: "Your campusRide driver has arrived",
  trip_completed: "Your campusRide trip is complete",
  driver_cancelled: "Your campusRide ride was cancelled",
  campus_cancelled: "Your campusRide seat is cancelled",
  campus_no_ride: "No driver took your campusRide seat",
  campus_ride_ended: "Your campusRide ride ended before boarding",
  campus_refund_declined: "Your campusRide refund needs a look",
  campus_seats_open: "A seat just opened on your campusRide route",
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
  // The refund templates share a shape: what happened, then the money. The
  // amount is only named when the policy actually owes one, so a cancellation
  // the passenger keeps paying for does not read like a refund.
  if (template === "campus_cancelled") {
    const refund = context.amount ? ` ${cedis(context.amount)} is on its way back to you.` : " No refund is due for this seat.";
    return { title: "Ride cancelled", message: `Your campusRide seat is cancelled.${refund}` };
  }
  if (template === "campus_no_ride") {
    const waited = context.windowMinutes ? ` inside ${context.windowMinutes} minutes` : "";
    return {
      title: "No driver found",
      message: `No driver took your seat${waited}, so your fare is being refunded. ${cedis(context.amount || 0)} is on the way back to you.`,
    };
  }
  if (template === "campus_refund_declined") {
    return {
      title: "Refund to review",
      message: "We could not send your campusRide refund automatically. Reply to this message and support will finish it by hand.",
    };
  }
  if (template === "campus_ride_ended") {
    return {
      title: "Ride ended",
      message: `Your campusRide trip ended before you boarded. ${cedis(context.amount || 0)} is on the way back to you.`,
    };
  }
  return { title: "Ride cancelled", message: `${driver} cancelled your pickup. Join the queue again for another ride.` };
}

/**
 * The message a watched route sends when a seat opens. It answers the two
 * questions the student is about to ask — which run, and what it costs — so the
 * decision can be made without opening the app first.
 */
export function campusSeatWatchNotice(input: { corridorName: string; seatsOpen: number; fare: number }) {
  const corridor = input.corridorName || "your campusRide route";
  const seats = Math.max(1, Math.round(input.seatsOpen || 1));
  const seatLine = seats === 1 ? "A seat has opened" : `${seats} seats have opened`;
  const fareLine = input.fare ? ` for GH₵ ${(input.fare / 100).toFixed(2)}` : "";
  return {
    title: "A seat opened",
    message: `${seatLine} on ${corridor}${fareLine}. Open campusRide and join the queue before it fills.`,
  };
}

/** Queue status that triggers a passenger notification, if any. */
export const CAMPUS_NOTIFY_BY_STATUS: Record<string, CampusNotifyTemplate> = {
  ACCEPTED_BY_DRIVER: "driver_accepted",
  DRIVER_ARRIVED: "driver_arrived",
  COMPLETED: "trip_completed",
  CANCELLED_BY_DRIVER: "driver_cancelled",
};
