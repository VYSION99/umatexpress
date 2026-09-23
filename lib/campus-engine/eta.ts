import { distanceKm } from "@/lib/campus-location";
import { waitLabel } from "@/lib/campus-engine/progress";

/**
 * How far away the driver is, in the only terms a waiting student cares about:
 * minutes.
 *
 * Two rules keep the number honest. It is built from the driver's *last
 * reported* position, so a phone that stopped reporting twenty minutes ago
 * cannot promise a four-minute arrival — a stale fix falls back to the
 * corridor's own estimate rather than pretending to be live. And it names the
 * pickup zone as a place rather than a distance: once the driver is inside the
 * zone they are not "200 m away", they are here.
 */

/** A shuttle on campus, stopping, turning and waiting at gates. */
export const CAMPUS_ASSUMED_SPEED_KMH = 18;
/** Finding a bay and getting people in, once the vehicle has arrived. */
export const CAMPUS_MARSHALLING_MINUTES = 2;
/** A position fix older than this is history, not a live ETA. */
export const CAMPUS_POSITION_STALE_MINUTES = 3;
/** Nobody believes a shuttle that is an hour away, and nobody needs the number. */
const MAX_ETA_MINUTES = 45;
/** Inside this, the driver is in the zone; naming metres would read as a bug. */
const AT_PICKUP_KM = 0.05;

export type CampusPickupEtaSource = "AT_PICKUP" | "DRIVER_POSITION" | "CORRIDOR_ESTIMATE" | "UNKNOWN";

export type CampusPickupEta = {
  /** Minutes until the driver reaches the passenger, or null when there is no basis for a number. */
  minutes: number | null;
  /** The line the ticket shows. */
  label: string;
  /** Only set when the estimate is built from a live position. */
  distanceKm: number | null;
  source: CampusPickupEtaSource;
  /** Why the estimate is only a corridor guess, when it is. */
  note: string;
};

export type CampusPickupEtaInput = {
  driverPosition?: { latitude?: number | null; longitude?: number | null } | null;
  /** When the position was reported, as an ISO string. Empty means unknown. */
  driverPositionAt?: string;
  pickupZone?: { latitude?: number | null; longitude?: number | null } | null;
  driverZoneId?: string;
  pickupZoneId?: string;
  /** The driver has marked themselves arrived. */
  arrived?: boolean;
  /** The corridor's own estimate, used when there is no live position. */
  corridorMinutes?: number;
  now?: number;
};

function coordinate(source?: { latitude?: number | null; longitude?: number | null } | null) {
  const latitude = Number(source?.latitude);
  const longitude = Number(source?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // An untouched REAL column reads as 0; the Gulf of Guinea is not a campus.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

function positionIsFresh(at: string | undefined, now: number) {
  const stamp = Date.parse(String(at || ""));
  if (!Number.isFinite(stamp)) return false;
  return now - stamp <= CAMPUS_POSITION_STALE_MINUTES * 60_000;
}

export function campusPickupEta(input: CampusPickupEtaInput): CampusPickupEta {
  const now = Number(input.now ?? Date.now());
  // No route time means no fallback number at all — not a made-up one minute.
  const routeMinutes = Math.max(0, Math.round(Number(input.corridorMinutes) || 0));
  const corridorMinutes = routeMinutes > 0 ? routeMinutes : null;

  if (input.arrived) {
    return { minutes: 1, label: "At your pickup zone", distanceKm: null, source: "AT_PICKUP", note: "" };
  }

  const driverPosition = coordinate(input.driverPosition);
  const pickupZone = coordinate(input.pickupZone);
  const sameZone = Boolean(input.driverZoneId && input.pickupZoneId && input.driverZoneId === input.pickupZoneId);
  const live = driverPosition && positionIsFresh(input.driverPositionAt, now);

  if (live && sameZone) {
    return { minutes: 1, label: waitLabel(1), distanceKm: 0, source: "AT_PICKUP", note: "" };
  }

  if (live && driverPosition && pickupZone) {
    const km = distanceKm(driverPosition, pickupZone);
    if (Number.isFinite(km) && km <= AT_PICKUP_KM) {
      return { minutes: 1, label: waitLabel(1), distanceKm: km, source: "AT_PICKUP", note: "" };
    }
    if (Number.isFinite(km)) {
      const travel = Math.ceil((km / CAMPUS_ASSUMED_SPEED_KMH) * 60);
      const minutes = Math.max(1, Math.min(MAX_ETA_MINUTES, travel + CAMPUS_MARSHALLING_MINUTES));
      return { minutes, label: waitLabel(minutes), distanceKm: km, source: "DRIVER_POSITION", note: "" };
    }
  }

  // No usable fix: say what the corridor takes, and say that is what it is.
  if (corridorMinutes) {
    const minutes = Math.max(1, Math.min(MAX_ETA_MINUTES, corridorMinutes + CAMPUS_MARSHALLING_MINUTES));
    return {
      minutes,
      label: waitLabel(minutes),
      distanceKm: null,
      source: "CORRIDOR_ESTIMATE",
      note: driverPosition ? "The driver's last position is out of date, so this is the route's usual time." : "The driver has not shared a live position yet, so this is the route's usual time.",
    };
  }

  return { minutes: null, label: "On the way", distanceKm: null, source: "UNKNOWN", note: "No position and no route estimate are available yet." };
}
