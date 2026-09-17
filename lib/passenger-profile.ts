/**
 * The passenger profile is device-local on purpose.
 *
 * UMaTeXPRESS has no student accounts yet: drivers and admins sign in, but a
 * passenger is identified only by the name, email and phone they type into a
 * booking form. So this module keeps those three fields (plus the tickets this
 * device has already opened) in the browser only. Nothing here is uploaded, and
 * nothing here can be read from another device or by another passenger.
 *
 * The same three fields were previously remembered by the campusRide queue form
 * under `umx_campus_rider`; that key is still read once and then retired so
 * existing riders keep their saved details.
 */

export type PassengerProfile = {
  name: string;
  email: string;
  phone: string;
  updatedAt: string;
};

export type SavedTicket = {
  reference: string;
  kind: "campus" | "vacation";
  savedAt: string;
};

const PROFILE_KEY = "umatexpress.passenger.v1";
const TICKETS_KEY = "umatexpress.tickets.v1";
const LEGACY_RIDER_KEY = "umx_campus_rider";

/** Dispatched on `window` whenever the profile or the ticket list changes. */
export const PASSENGER_EVENT = "umatexpress:passenger-changed";

/** Keys this module owns, so listeners can filter storage events. */
export const PASSENGER_STORAGE_KEYS = [PROFILE_KEY, TICKETS_KEY, LEGACY_RIDER_KEY];

const MAX_FIELD_LENGTH = 120;
const MAX_TICKETS = 12;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Storage access itself can throw (Safari private mode, blocked cookies), so the
// lookup is guarded rather than assumed.
function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; }
  catch { return null; }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LENGTH) : "";
}

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

// Reading can throw too (Safari private mode, storage disabled by policy), not
// just writing — so every access goes through a guarded read.
function readKey(store: StorageLike | null, key: string): string | null {
  if (!store) return null;
  try { return store.getItem(key); }
  catch { return null; }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Coerces anything to a usable profile, or null when there is nothing to keep.
 * `passengerName` is accepted because that is how the campusRide form stored it.
 */
export function normalizeProfile(value: unknown): PassengerProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = text(row.name ?? row.passengerName);
  const email = text(row.email);
  const phone = text(row.phone);
  if (!name && !email && !phone) return null;
  return { name, email, phone, updatedAt: text(row.updatedAt) || nowIso() };
}

export function readProfile(store: StorageLike | null = defaultStorage()): PassengerProfile | null {
  if (!store) return null;
  return normalizeProfile(parse(readKey(store, PROFILE_KEY)))
    ?? normalizeProfile(parse(readKey(store, LEGACY_RIDER_KEY)));
}

/** Saves the profile and retires the legacy campusRide key. Returns false when storage refused the write. */
export function writeProfile(value: { name?: string; email?: string; phone?: string }, store: StorageLike | null = defaultStorage()): boolean {
  const profile = normalizeProfile(value);
  if (!profile || !store) return false;
  try {
    store.setItem(PROFILE_KEY, JSON.stringify(profile));
    store.removeItem(LEGACY_RIDER_KEY);
    return true;
  } catch { return false; }
}

export function clearProfile(store: StorageLike | null = defaultStorage()): boolean {
  if (!store) return false;
  try {
    store.removeItem(PROFILE_KEY);
    store.removeItem(LEGACY_RIDER_KEY);
    return true;
  } catch { return false; }
}

/** The greeting name: first word of the saved name, or "" when nothing is saved. */
export function profileName(profile: PassengerProfile | null) {
  return profile?.name.split(/\s+/).filter(Boolean)[0] || "";
}

export function readSavedTickets(store: StorageLike | null = defaultStorage()): SavedTicket[] {
  const rows = parse(readKey(store, TICKETS_KEY));
  if (!Array.isArray(rows)) return [];
  const tickets: SavedTicket[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Record<string, unknown>;
    const reference = text(candidate.reference);
    const kind = candidate.kind === "campus" ? "campus" : candidate.kind === "vacation" ? "vacation" : null;
    if (!reference || !kind || tickets.some(ticket => ticket.reference === reference)) continue;
    tickets.push({ reference, kind, savedAt: text(candidate.savedAt) });
  }
  return tickets;
}

/**
 * Records a ticket opened on this device, newest first, de-duplicated by
 * reference and capped so the list cannot grow without bound.
 */
export function rememberTicket(input: { reference?: string; kind: SavedTicket["kind"] }, store: StorageLike | null = defaultStorage()): boolean {
  const reference = text(input.reference);
  if (!reference || !store) return false;
  const kept = readSavedTickets(store).filter(ticket => ticket.reference !== reference);
  const next: SavedTicket[] = [{ reference, kind: input.kind, savedAt: nowIso() }, ...kept].slice(0, MAX_TICKETS);
  try {
    store.setItem(TICKETS_KEY, JSON.stringify(next));
    return true;
  } catch { return false; }
}

export function forgetTicket(reference: string, store: StorageLike | null = defaultStorage()): boolean {
  const target = text(reference);
  if (!target || !store) return false;
  try {
    store.setItem(TICKETS_KEY, JSON.stringify(readSavedTickets(store).filter(ticket => ticket.reference !== target)));
    return true;
  } catch { return false; }
}

/** Where a saved reference can be verified again. The ticket page re-checks it with the server. */
export function ticketHref(ticket: Pick<SavedTicket, "reference" | "kind">) {
  const reference = encodeURIComponent(ticket.reference);
  return ticket.kind === "campus" ? `/campus/ticket?reference=${reference}` : `/payment/callback?reference=${reference}`;
}

/** Tells every mounted consumer that the profile changed. Safe outside the browser. */
export function notifyPassengerChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PASSENGER_EVENT));
}
