/** Human-readable riding states, in the order a passenger experiences them. */
export const CAMPUS_QUEUE_STEPS = [
  { key: "PAID_WAITING", label: "Payment confirmed", hint: "Waiting for a driver to accept you." },
  { key: "ACCEPTED_BY_DRIVER", label: "Driver accepted", hint: "Your driver is on the way to you." },
  { key: "DRIVER_ARRIVED", label: "Driver arrived", hint: "Meet your driver at the pickup zone." },
  { key: "BOARDED", label: "Boarded", hint: "Have your boarding PIN ready if asked." },
  { key: "COMPLETED", label: "Trip completed", hint: "Thanks for riding with campusRide." },
] as const;

export type CampusQueueStepKey = (typeof CAMPUS_QUEUE_STEPS)[number]["key"];
export type CampusQueueStepState = "done" | "current" | "upcoming" | "skipped";

/** States that end the ride, so the timeline is replaced by a plain message. */
const TERMINAL_STATES: Record<string, { label: string; hint: string }> = {
  WAITING_PAYMENT: { label: "Awaiting payment", hint: "Complete payment to lock in your queue position." },
  PAYMENT_RECEIVED_REVIEW: { label: "Payment under review", hint: "We are matching your payment manually. You will be contacted." },
  PAYMENT_FAILED: { label: "Payment failed", hint: "The payment did not go through. Join the queue again to retry." },
  EXPIRED: { label: "Hold expired", hint: "The checkout hold ran out before payment. Join the queue again." },
  CANCELLED_BY_STUDENT: { label: "Cancelled", hint: "This ride was cancelled." },
  CANCELLED_BY_DRIVER: { label: "Cancelled by driver", hint: "The driver cancelled. Join another campusRide." },
  NO_SHOW: { label: "Missed pickup", hint: "The driver marked this trip as a no-show." },
};

export type CampusQueueProgress =
  | { state: "active"; status: string; label: string; hint: string; index: number; steps: Array<{ key: CampusQueueStepKey; label: string; hint: string; state: CampusQueueStepState }> }
  | { state: "terminal"; status: string; label: string; hint: string; steps: Array<{ key: CampusQueueStepKey; label: string; hint: string; state: CampusQueueStepState }> }
  | { state: "unknown"; status: string; label: string; hint: string; steps: Array<{ key: CampusQueueStepKey; label: string; hint: string; state: CampusQueueStepState }> };

function decorate(current: number): CampusQueueProgress["steps"] {
  return CAMPUS_QUEUE_STEPS.map((step, index) => ({
    ...step,
    state: current < 0 ? "upcoming" : index < current ? "done" : index === current ? "current" : "upcoming",
  }));
}

/** Turns a raw queue status into the passenger-facing timeline. */
export function queueProgress(status: string): CampusQueueProgress {
  const normalized = String(status || "").toUpperCase();
  const index = CAMPUS_QUEUE_STEPS.findIndex((step) => step.key === normalized);
  if (index >= 0) {
    return { state: "active", status: normalized, label: CAMPUS_QUEUE_STEPS[index].label, hint: CAMPUS_QUEUE_STEPS[index].hint, index, steps: decorate(index) };
  }
  const terminal = TERMINAL_STATES[normalized];
  if (terminal) return { state: "terminal", status: normalized, label: terminal.label, hint: terminal.hint, steps: decorate(-1) };
  return { state: "unknown", status: normalized, label: "Status unavailable", hint: "Pull to refresh for the latest update.", steps: decorate(-1) };
}

/**
 * Rough minutes until the driver reaches this passenger.
 *
 * A shuttle picks riders up in batches of its capacity, so someone with `n`
 * active riders ahead waits for `ceil((n + 1) / capacity)` trips. This is an
 * estimate for reassurance, not a promise.
 */
export function estimateWaitMinutes(input: { peopleAhead: number; capacity: number; tripMinutes: number }) {
  const capacity = Math.max(1, Math.round(input.capacity || 1));
  const tripMinutes = Math.max(1, Math.round(input.tripMinutes || 1));
  const batches = Math.ceil((Math.max(0, Math.round(input.peopleAhead || 0)) + 1) / capacity);
  return Math.max(1, Math.min(180, tripMinutes * batches));
}

export function waitLabel(minutes: number) {
  if (minutes <= 2) return "Arriving now";
  if (minutes < 60) return `About ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `About ${hours}h ${rest}m` : `About ${hours}h`;
}
