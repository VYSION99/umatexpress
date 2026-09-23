import { CampusEngineError } from "@/lib/campus-engine/errors";
import { cedis, inspectCampusFare, simulateCampusTrip, type CampusFareCheck, type CampusFarePolicy } from "@/lib/campus-fare-math";
import { platformSettingNumber } from "@/lib/platform-settings";

/**
 * The campusRide tariff policy, read from the console settings.
 *
 * The arithmetic lives in `lib/campus-fare-math.ts` so the console can preview a
 * floor with the same code that will refuse the fare. This module is the part
 * that knows where the numbers and the corridors come from.
 */

export type CampusFareInputs = { distanceKm?: number; estimatedMinutes?: number; plannedSeats?: number };

export async function campusFarePolicy(): Promise<CampusFarePolicy> {
  const [costPerKm, costPerMinute, standingCost, assumedSeats, loadFactorBps, maxMarkupBps, minFare, maxFare, commissionBps] = await Promise.all([
    platformSettingNumber("campus_fare_cost_per_km"),
    platformSettingNumber("campus_fare_cost_per_minute"),
    platformSettingNumber("campus_fare_standing_cost"),
    platformSettingNumber("campus_fare_assumed_seats"),
    platformSettingNumber("campus_fare_load_factor_bps"),
    platformSettingNumber("campus_fare_max_markup_bps"),
    platformSettingNumber("campus_fare_min_amount"),
    platformSettingNumber("campus_fare_max_amount"),
    platformSettingNumber("campus_commission_bps"),
  ]);
  return { costPerKm, costPerMinute, standingCost, assumedSeats, loadFactorBps, maxMarkupBps, minFare, maxFare, commissionBps };
}

/** A corridor's own numbers, as the guardrails need them. */
export function corridorFareInputs(corridor: CampusFareInputs) {
  const plannedSeats = Math.max(0, Math.round(Number(corridor.plannedSeats) || 0));
  return {
    distanceKm: Math.max(0, Number(corridor.distanceKm) || 0),
    minutes: Math.max(0, Number(corridor.estimatedMinutes) || 0),
    // A corridor with no plan of its own falls back to the platform plan
    // (planned seats × load factor) rather than to a plan of zero seats.
    seats: plannedSeats > 0 ? plannedSeats : undefined,
  };
}

export async function inspectCorridorFare(input: { fare: number; corridor: CampusFareInputs }) {
  const policy = await campusFarePolicy();
  return { policy, check: inspectCampusFare({ fare: input.fare, ...corridorFareInputs(input.corridor), policy }) };
}

/**
 * Refuses a tariff the guardrails will not carry.
 *
 * Two refusals are absolute: a fare outside the band is a typo in a cedis field,
 * and a fare above the ceiling is a price the platform would have to invent. A
 * fare below the floor is a real decision — a subsidised route, an introductory
 * price — so it is refused until someone says it is intended, and the
 * acknowledgement is recorded on the fare row and in the audit log. The order
 * matters: the band is checked first so a mistyped fare is reported as a typo
 * rather than argued about on economics.
 */
export function assertCampusFareAllowed(check: CampusFareCheck, options: { acknowledgeBelowFloor?: boolean } = {}) {
  if (check.outOfRange || check.aboveCeiling) throw new CampusEngineError("VALIDATION_ERROR", check.message, 400);
  if (check.belowFloor && !options.acknowledgeBelowFloor) throw new CampusEngineError("VALIDATION_ERROR", check.message, 400);
}

export type CampusFareStatus = "OK" | "BELOW_FLOOR" | "ABOVE_CEILING" | "OUT_OF_RANGE" | "UNPRICED" | "UNCHECKED";

export type CampusFareReportRow = {
  corridorId: string;
  corridor: string;
  fare: number;
  distanceKm: number;
  minutes: number;
  tripCost: number;
  costFloor: number;
  floor: number;
  ceiling: number;
  status: CampusFareStatus;
  perSeatLoss: number;
  /** The seats this corridor is planned to sell: its own plan, or the platform plan. */
  plannedSeats: number;
  /** The corridor's own plan, or 0 when the platform plan decides. */
  plannedSeatsOverride: number;
  /** What the driver keeps on a typical departure after the run has paid for itself. */
  driverSurplus: number;
  platformMargin: number;
  message: string;
};

/**
 * Where every corridor sits against the guardrails.
 *
 * A fare saved before the guardrails existed has no floor recorded, which is a
 * different fact from a fare that was checked and passed — so it reads
 * `UNCHECKED` rather than `OK`, and the console can ask for it to be re-saved.
 */
export async function campusFareReport(corridors: Array<CampusFareInputs & { id: string; name: string; fare: number; floorAmount?: number; ceilingAmount?: number }>) {
  const policy = await campusFarePolicy();
  const rows: CampusFareReportRow[] = corridors.map((corridor) => {
    const inputs = corridorFareInputs(corridor);
    const check = inspectCampusFare({ fare: corridor.fare, ...inputs, policy });
    const plannedSeatsOverride = Math.max(0, Math.round(Number(corridor.plannedSeats) || 0));
    // A corridor's plan can exceed the platform's assumed vehicle, and a "full
    // vehicle" below the planned load would be a number that cannot happen.
    const simulation = simulateCampusTrip({ fare: check.fare, capacity: Math.max(policy.assumedSeats, plannedSeatsOverride), ...inputs, policy });
    const status: CampusFareStatus = !check.fare
      ? "UNPRICED"
      : check.outOfRange
        ? "OUT_OF_RANGE"
        : check.aboveCeiling
          ? "ABOVE_CEILING"
          : check.belowFloor
            ? "BELOW_FLOOR"
            : Number(corridor.floorAmount || 0) > 0 ? "OK" : "UNCHECKED";
    return {
      corridorId: corridor.id,
      corridor: corridor.name,
      fare: check.fare,
      distanceKm: inputs.distanceKm,
      minutes: inputs.minutes,
      tripCost: check.tripCost,
      costFloor: check.costFloor,
      floor: check.floor,
      ceiling: check.ceiling,
      status,
      perSeatLoss: check.perSeatLoss,
      plannedSeats: simulation.atPlannedLoad.seats,
      plannedSeatsOverride,
      driverSurplus: simulation.atPlannedLoad.driverSurplus,
      platformMargin: simulation.atPlannedLoad.platformMargin,
      message: check.message,
    };
  });

  const belowFloor = rows.filter((row) => row.status === "BELOW_FLOOR");
  const unchecked = rows.filter((row) => row.status === "UNCHECKED" || row.status === "UNPRICED");
  return {
    policy,
    rows,
    summary: {
      corridors: rows.length,
      belowFloor: belowFloor.length,
      unchecked: unchecked.length,
      /** The largest per-seat loss any corridor is running at, in pesewas. */
      worstPerSeatLoss: belowFloor.reduce((worst, row) => Math.max(worst, row.perSeatLoss), 0),
      /** The platform's share of one departure on every corridor that is priced and inside the band. */
      marginPerDeparture: rows.filter((row) => row.status === "OK" || row.status === "UNCHECKED").reduce((total, row) => total + row.platformMargin, 0),
      commissionBps: policy.commissionBps,
      /** False until operations confirms the fuel price, consumption and driver cost behind the settings. */
      costInputsConfirmed: false,
    },
    note: "The floor is arithmetic on the recommended cost settings until operations confirms the fuel price, the consumption and the driver cost they actually see. Every floor and ceiling moves with those three numbers.",
  };
}

/** What `campusFareReport` returns, so a console type cannot drift from it. */
export type CampusFareReport = Awaited<ReturnType<typeof campusFareReport>>;

/** One line for a console that wants to show the guardrail without the table. */
export async function describeCampusFare(corridor: CampusFareInputs & { fare: number }) {
  const { check } = await inspectCorridorFare({ fare: corridor.fare, corridor });
  if (check.ok) return `Inside the ${cedis(check.floor)}–${cedis(check.ceiling)} band for this corridor.`;
  return check.message;
}
