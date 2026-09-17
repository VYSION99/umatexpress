import { CampusEngineError } from "@/lib/campus-engine/errors";

export const rideStates = [
  "DRAFT",
  "SEARCHING",
  "DRIVER_ASSIGNED",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "DRIVER_EN_ROUTE",
  "DRIVER_ARRIVED",
  "PIN_VERIFIED",
  "IN_PROGRESS",
  "COMPLETED",
  "NO_DRIVER_FOUND",
  "PAYMENT_FAILED",
  "CANCELLED_BY_STUDENT",
  "CANCELLED_BY_DRIVER",
  "NO_SHOW",
  "DISPUTED",
] as const;

export type CampusRideState = typeof rideStates[number];

const transitions: Record<CampusRideState, CampusRideState[]> = {
  DRAFT: ["SEARCHING", "CANCELLED_BY_STUDENT"],
  SEARCHING: ["DRIVER_ASSIGNED", "NO_DRIVER_FOUND", "CANCELLED_BY_STUDENT"],
  DRIVER_ASSIGNED: ["AWAITING_PAYMENT", "CANCELLED_BY_DRIVER", "CANCELLED_BY_STUDENT"],
  AWAITING_PAYMENT: ["CONFIRMED", "PAYMENT_FAILED", "CANCELLED_BY_STUDENT"],
  CONFIRMED: ["DRIVER_EN_ROUTE", "CANCELLED_BY_STUDENT"],
  DRIVER_EN_ROUTE: ["DRIVER_ARRIVED", "CANCELLED_BY_DRIVER"],
  DRIVER_ARRIVED: ["PIN_VERIFIED", "NO_SHOW", "CANCELLED_BY_STUDENT"],
  PIN_VERIFIED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED", "DISPUTED"],
  COMPLETED: ["DISPUTED"],
  NO_DRIVER_FOUND: [],
  PAYMENT_FAILED: ["AWAITING_PAYMENT", "CANCELLED_BY_STUDENT"],
  CANCELLED_BY_STUDENT: [],
  CANCELLED_BY_DRIVER: [],
  NO_SHOW: ["DISPUTED"],
  DISPUTED: [],
};

export function assertRideTransition(from: string, to: CampusRideState) {
  const current = rideStates.includes(from as CampusRideState) ? from as CampusRideState : "DRAFT";
  if (!transitions[current].includes(to)) {
    throw new CampusEngineError("INVALID_STATE", `Cannot move ride from ${current} to ${to}.`, 409);
  }
}

export function ridePin() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(1000 + (bytes[0] % 9000));
}
