import { splitCommission } from "@/lib/money";

/**
 * The campusRide tariff guardrails, as arithmetic.
 *
 * A campus fare is one published number per corridor and it does not move with
 * demand, which is what makes a hike impossible and also what leaves the tariff
 * unable to defend itself. These functions defend it from the two sides: a floor
 * the driver cannot go below without losing money, and a ceiling a passenger
 * cannot be charged above without the platform inventing a price.
 *
 * Nothing here reads a database or a setting — the policy is an argument. That
 * keeps the console able to preview a floor before a fare is saved with exactly
 * the same code that will refuse it, instead of the two drifting apart.
 */

export type CampusFarePolicy = {
  /** Fuel, tyres and wear for one kilometre, in pesewas. */
  costPerKm: number;
  /** The driver's own time for one minute, in pesewas. */
  costPerMinute: number;
  /** What a departure costs whether or not it sells a seat, in pesewas. */
  standingCost: number;
  /** The seats a corridor is planned around. */
  assumedSeats: number;
  /** The share of those seats a trip is expected to sell, in basis points. */
  loadFactorBps: number;
  /** How far above the floor a corridor may be priced, in basis points. */
  maxMarkupBps: number;
  /** The absolute band a fare must sit inside, in pesewas. */
  minFare: number;
  maxFare: number;
  /** The platform's share of the fare, in basis points. */
  commissionBps: number;
};

/**
 * The shipped defaults, as recommendations rather than measurements.
 *
 * 240 pesewas a kilometre is fuel and wear for a small shuttle: roughly
 * GH₵15.00 a litre at about 13 litres per 100 km is GH₵1.95 of fuel, plus about
 * GH₵0.45 of tyres, servicing and replacement set aside per kilometre.
 *
 * 30 pesewas a minute is the fully loaded cost of keeping the vehicle *and* the
 * driver occupied: a driver on about GH₵80 a day plus GH₵25 of insurance,
 * licence and standing costs, spread over 360 productive minutes. It is a cost
 * per vehicle-minute, not a wage per minute, because the minute a trip takes is
 * a minute no other trip can use.
 *
 * 150 pesewas per departure covers what a round trip costs whatever its length —
 * the wait at the gate, and the marshalling that happens once.
 *
 * Every one of them is a console setting, and the derivation is written out in
 * `docs/CampusRide/FARE_POLICY.md`. A floor computed from an unconfirmed number
 * is still a suggestion, and the operations console says so next to every floor
 * it shows.
 */
export const DEFAULT_CAMPUS_FARE_POLICY: CampusFarePolicy = {
  costPerKm: 240,
  costPerMinute: 30,
  standingCost: 150,
  assumedSeats: 6,
  loadFactorBps: 7_000,
  maxMarkupBps: 6_000,
  minFare: 100,
  maxFare: 3_000,
  commissionBps: 1_000,
};

export function cedis(pesewas: number) {
  return `GH₵ ${(Math.max(0, Math.round(Number(pesewas) || 0)) / 100).toFixed(2)}`;
}

/**
 * Seats a tariff is planned to sell. A trip that runs half empty still has to
 * cover itself.
 *
 * A corridor may name its own number: a run served by a fourteen-seat bus is
 * planned to sell far more seats than a two-kilometre hop in a six-seat
 * shuttle, and saying so lowers its floor without anyone subsidising it. The
 * override is the seats sold, not the seats in the vehicle — the platform plan
 * multiplies seats by the load factor, so a corridor that overrides has already
 * made that judgement itself.
 */
export function campusFareSeats(policy: CampusFarePolicy, seatsOverride?: number) {
  const override = Math.max(0, Math.round(Number(seatsOverride) || 0));
  if (override > 0) return override;
  const seats = Math.max(1, Math.round(Number(policy.assumedSeats) || 0));
  const share = Math.max(0, Math.min(10_000, Math.round(Number(policy.loadFactorBps) || 0)));
  return Math.max(1, Math.floor((seats * share) / 10_000));
}

/**
 * What one trip costs to run, in pesewas. A shuttle that leaves a gate has to
 * come back, so both the distance and the time are counted twice.
 */
export function campusTripCost(input: { distanceKm?: number; minutes?: number; policy: CampusFarePolicy }) {
  const distanceKm = Math.max(0, Number(input.distanceKm) || 0);
  const minutes = Math.max(0, Number(input.minutes) || 0);
  const { policy } = input;
  return Math.round(distanceKm * 2 * (Number(policy.costPerKm) || 0))
    + Math.round(minutes * 2 * (Number(policy.costPerMinute) || 0))
    + Math.max(0, Math.round(Number(policy.standingCost) || 0));
}

/** The fare at which the driver is whole, before the platform takes anything. */
export function campusCostFloor(input: { distanceKm?: number; minutes?: number; seats?: number; policy: CampusFarePolicy }) {
  return Math.ceil(campusTripCost(input) / campusFareSeats(input.policy, input.seats));
}

/**
 * The fare at which the driver is whole *and* the commission is covered. The
 * commission comes out of the price rather than out of the driver's cost, so the
 * cost floor is divided by the commission's complement instead of being used
 * as-is: a fare sitting exactly on `campusCostFloor` would leave the driver short
 * by the platform's share of it.
 */
export function campusFareFloor(input: { distanceKm?: number; minutes?: number; seats?: number; policy: CampusFarePolicy }) {
  const rate = Math.max(0, Math.min(9_999, Math.round(Number(input.policy.commissionBps) || 0)));
  return Math.ceil(campusCostFloor(input) / (1 - rate / 10_000));
}

/** The most a corridor may charge: the floor plus a published markup. */
export function campusFareCeiling(input: { floor: number; policy: CampusFarePolicy }) {
  const markup = Math.max(0, Math.round(Number(input.policy.maxMarkupBps) || 0));
  return Math.ceil((Math.max(0, Math.round(input.floor)) * (10_000 + markup)) / 10_000);
}

export type CampusFareCheck = {
  fare: number;
  tripCost: number;
  plannedSeats: number;
  costFloor: number;
  floor: number;
  ceiling: number;
  /** The fare is outside the absolute band, which is the typo a cedis field invites. */
  outOfRange: boolean;
  belowFloor: boolean;
  aboveCeiling: boolean;
  /** What every seat sold at this fare costs the driver, in pesewas. */
  perSeatLoss: number;
  ok: boolean;
  message: string;
};

/** Where a fare sits between the floor and the ceiling, and why it is refused if it is not. */
export function inspectCampusFare(input: { fare: number; distanceKm?: number; minutes?: number; seats?: number; policy: CampusFarePolicy }): CampusFareCheck {
  const { policy } = input;
  const fare = Math.max(0, Math.round(Number(input.fare) || 0));
  const tripCost = campusTripCost(input);
  const plannedSeats = campusFareSeats(policy, input.seats);
  const costFloor = campusCostFloor(input);
  const floor = campusFareFloor(input);
  const ceiling = campusFareCeiling({ floor, policy });
  const minFare = Math.max(0, Math.round(Number(policy.minFare) || 0));
  const maxFare = Math.max(minFare, Math.round(Number(policy.maxFare) || 0));
  const outOfRange = fare < minFare || fare > maxFare;
  const belowFloor = !outOfRange && fare < floor;
  const aboveCeiling = !outOfRange && fare > ceiling;
  const perSeatLoss = belowFloor ? floor - fare : 0;

  let message = "";
  if (outOfRange) {
    message = `A campus fare must be between ${cedis(minFare)} and ${cedis(maxFare)}. ${cedis(fare)} is outside that band. If that price is intended, widen the fare range before saving it.`;
  } else if (aboveCeiling) {
    message = `${cedis(fare)} is above the ceiling of ${cedis(ceiling)} for this corridor. The floor is ${cedis(floor)} and the markup ceiling is ${(policy.maxMarkupBps / 100).toFixed(0)}%. Lower the fare, or raise the markup ceiling if the price is intended.`;
  } else if (belowFloor) {
    message = `${cedis(fare)} is below the ${cedis(floor)} floor for this corridor: a trip costs ${cedis(tripCost)} to run and the tariff is planned around ${plannedSeats} seat${plannedSeats === 1 ? "" : "s"}. Every seat sold loses ${cedis(perSeatLoss)}. Save it only if that loss is intended.`;
  }

  return { fare, tripCost, plannedSeats, costFloor, floor, ceiling, outOfRange, belowFloor, aboveCeiling, perSeatLoss, ok: !outOfRange && !belowFloor && !aboveCeiling, message };
}

/**
 * What one departure earns who, at the load the tariff is planned around and at
 * a full vehicle. `driverSurplus` is what is left for the driver after the run
 * has paid for itself, so a negative number is a trip that costs the driver to
 * drive.
 */
export function simulateCampusTrip(input: { fare: number; capacity?: number; distanceKm?: number; minutes?: number; seats?: number; policy: CampusFarePolicy }) {
  const { policy } = input;
  const fare = Math.max(0, Math.round(Number(input.fare) || 0));
  const tripCost = campusTripCost(input);
  const plannedSeats = campusFareSeats(policy, input.seats);
  const capacity = Math.max(1, Math.round(Number(input.capacity) || 0));
  const floor = campusFareFloor(input);
  const ceiling = campusFareCeiling({ floor, policy });

  const legFor = (seats: number) => {
    const split = splitCommission(fare * seats, policy.commissionBps);
    return {
      seats,
      gross: split.gross,
      commission: split.commission,
      driverNet: split.net,
      driverSurplus: split.net - tripCost,
      platformMargin: split.commission,
      tripSurplus: split.gross - tripCost,
    };
  };

  return { fare, tripCost, plannedSeats, capacity, floor, ceiling, atPlannedLoad: legFor(plannedSeats), atCapacity: legFor(capacity) };
}
