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

export type NoticeRoute = { from: string; to: string };

/** One flyer on the public page: the platform's or a single organizer's. */
export type PublicNotice = {
  /** `platform` or the organizer id; the public page never keys on a raw id. */
  id: string;
  organizerName: string;
  platform: boolean;
  promo: FlyerPromo;
  /**
   * The live coaches the notice belongs to. The card composes its route line
   * from these, so a destination that has been retired stops being advertised.
   */
  routes: NoticeRoute[];
};

/**
 * A dash, or a currency symbol glued to one, is a placeholder a person left
 * while filling a form ("GHS ---"). It is not a fare, so it never ships.
 */
export function isPlaceholderText(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return true;
  const withoutCurrency = text.replace(/^(?:gh[s₵]+|₵)\s*/, "");
  return /^[-–—_.\s]*$/.test(withoutCurrency);
}

/** Collapses stray spacing so "Accra,Kumasi, Sunyani" reads as a written list. */
function tidyText(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
}

/** Drops every field that only holds a placeholder, so "---" never renders. */
export function cleanFlyerPromo(promo: FlyerPromo): FlyerPromo {
  const text = (value: string) => (isPlaceholderText(value) ? "" : tidyText(value));
  const list = (items: string[]) => items.map(tidyText).filter((item) => !isPlaceholderText(item));
  return {
    ...promo,
    title: text(promo.title),
    route: text(promo.route),
    fare: text(promo.fare),
    nightBus: text(promo.nightBus),
    dayBuses: list(promo.dayBuses),
    dropOffPoints: list(promo.dropOffPoints),
    amenities: list(promo.amenities),
    contacts: list(promo.contacts),
  };
}

/**
 * The notice's route line, composed from the coaches actually on sale. One
 * origin reads "UMaT Main Campus → Accra, Kumasi, Sunyani"; several origins are
 * listed as pairs. Returns "" when there is nothing live to show, so the caller
 * falls back to the text an administrator saved.
 */
export function composeRouteLine(routes: NoticeRoute[], maxPairs = 3) {
  const seen = new Set<string>();
  const clean: NoticeRoute[] = [];
  for (const route of routes || []) {
    const from = String(route?.from ?? "").trim();
    const to = String(route?.to ?? "").trim();
    if (!from || !to) continue;
    const key = `${from}\u0000${to}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ from, to });
  }
  if (!clean.length) return "";
  const origins = new Set(clean.map((route) => route.from.toLowerCase()));
  if (origins.size === 1) {
    const destinations = [...new Set(clean.map((route) => route.to))];
    return `${clean[0].from} → ${destinations.join(", ")}`;
  }
  const lines = clean.slice(0, maxPairs).map((route) => `${route.from} → ${route.to}`);
  if (clean.length > maxPairs) lines.push(`+${clean.length - maxPairs} more`);
  return lines.join(" · ");
}

/** Where a notice's live coaches actually set passengers down. */
export function noticeDestinations(routes: NoticeRoute[]) {
  const seen = new Set<string>();
  const destinations: string[] = [];
  for (const route of routes || []) {
    const to = String(route?.to ?? "").trim();
    if (!to || seen.has(to.toLowerCase())) continue;
    seen.add(to.toLowerCase());
    destinations.push(to);
  }
  return destinations;
}


export type NoticesForAssembly = {
  platform: FlyerPromo;
  platformRoutes: NoticeRoute[];
  organizers: { id: string; name: string; promo: FlyerPromo; routes: NoticeRoute[] }[];
};

/**
 * The public carousel order: the platform notice first, then each organizer's
 * by name. A notice that is switched off, empty, or placeholder-only is dropped
 * rather than rendered as a blank slide, and an organizer's notice only shows
 * while that organizer has at least one approved trip on sale — the platform
 * never amplifies a flyer that cannot be booked. Pure, so the ordering rules
 * are tested without a database.
 */
export function assemblePublicNotices(input: NoticesForAssembly): PublicNotice[] {
  const notices: PublicNotice[] = [];
  const platformPromo = cleanFlyerPromo(input.platform);
  if (platformPromo.enabled && hasNoticeContent(platformPromo)) {
    notices.push({
      id: "platform",
      organizerName: "UMaTeXPRESS",
      platform: true,
      promo: platformPromo,
      routes: input.platformRoutes,
    });
  }
  const organizers = [...input.organizers].sort((left, right) => left.name.localeCompare(right.name));
  for (const organizer of organizers) {
    const promo = cleanFlyerPromo(organizer.promo);
    if (!promo.enabled || !hasNoticeContent(promo)) continue;
    if (!organizer.routes.length) continue;
    notices.push({
      id: organizer.id,
      organizerName: organizer.name || "Organizer",
      platform: false,
      promo,
      routes: organizer.routes,
    });
  }
  return notices;
}
