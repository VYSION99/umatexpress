// Client-safe: no server imports, so rendering the public notice never pulls
// the database module into the browser bundle.
export type FlyerPromo = {
  enabled: boolean;
  title: string;
  route: string;
  fare: string;
  nightBus: string;
  dayBuses: string[];
  dropOffPoints: string[];
  amenities: string[];
  contacts: string[];
};

/**
 * Deliberately empty. The notice content is configuration, not source: it comes
 * from TRIP_NOTICE_* environment values or from what an organiser saved in the
 * console. Shipping sample fares and phone numbers as defaults meant an
 * unconfigured deployment published placeholder content as if it were real.
 */
export const EMPTY_FLYER_PROMO: FlyerPromo = {
  enabled: false,
  title: "",
  route: "",
  fare: "",
  nightBus: "",
  dayBuses: [],
  dropOffPoints: [],
  amenities: [],
  contacts: [],
};

export function hasNoticeContent(promo: FlyerPromo) {
  return Boolean(
    promo.title.trim()
    || promo.route.trim()
    || promo.fare.trim()
    || promo.nightBus.trim()
    || promo.dayBuses.length
    || promo.dropOffPoints.length
    || promo.amenities.length
    || promo.contacts.length,
  );
}

/**
 * `base` defaults to a blank notice, but callers merging a partial update should
 * pass the stored notice so an unset field keeps its saved value instead of
 * being wiped.
 */
export function normalizeFlyerPromo(value: unknown, base: FlyerPromo = EMPTY_FLYER_PROMO): FlyerPromo {
  const input = typeof value === "object" && value !== null ? value as Partial<FlyerPromo> : {};
  const strings = (items: unknown, fallback: string[]) => Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean)
    : fallback;
  const text = (candidate: unknown, fallback: string) => typeof candidate === "string" && candidate.trim() ? candidate.trim() : fallback;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    title: text(input.title, base.title),
    route: text(input.route, base.route),
    fare: text(input.fare, base.fare),
    nightBus: text(input.nightBus, base.nightBus),
    dayBuses: strings(input.dayBuses, base.dayBuses),
    dropOffPoints: strings(input.dropOffPoints, base.dropOffPoints),
    amenities: strings(input.amenities, base.amenities),
    contacts: strings(input.contacts, base.contacts),
  };
}
