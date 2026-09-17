"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  PASSENGER_EVENT,
  PASSENGER_STORAGE_KEYS,
  clearProfile,
  forgetTicket,
  readProfile,
  notifyPassengerChanged,
  readSavedTickets,
  writeProfile,
  type PassengerProfile,
  type SavedTicket,
} from "@/lib/passenger-profile";

// The snapshot has to be a stable string: re-reading storage on every render
// would hand React a fresh object each time and loop forever.
const snapshots = new Map<string, string>();

function snapshot() {
  const cached = snapshots.get("passenger");
  if (cached !== undefined) return cached;
  const profile = readProfile();
  const tickets = readSavedTickets();
  const raw = profile || tickets.length ? JSON.stringify({ profile, tickets }) : "";
  snapshots.set("passenger", raw);
  return raw;
}

function subscribe(callback: () => void) {
  const refresh = () => { snapshots.clear(); callback(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || PASSENGER_STORAGE_KEYS.includes(event.key)) refresh();
  };
  window.addEventListener(PASSENGER_EVENT, refresh);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(PASSENGER_EVENT, refresh); window.removeEventListener("storage", onStorage); };
}

const EMPTY = { profile: null as PassengerProfile | null, tickets: [] as SavedTicket[] };

/**
 * Reads the device-local passenger profile. The server snapshot is null, so the
 * first paint always shows the signed-out state and hydration cannot mismatch.
 */
export function usePassenger() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const state = useMemo(() => {
    if (raw === null || raw === "") return EMPTY;
    try {
      const parsed = JSON.parse(raw) as { profile?: PassengerProfile | null; tickets?: SavedTicket[] };
      return { profile: parsed.profile ?? null, tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [] };
    } catch { return EMPTY; }
  }, [raw]);
  const refresh = () => { snapshots.clear(); notifyPassengerChanged(); };
  return {
    ...state,
    ready: raw !== null,
    saveProfile(next: { name: string; email: string; phone: string }) {
      const saved = writeProfile(next);
      refresh();
      return saved;
    },
    clearProfile() {
      const cleared = clearProfile();
      refresh();
      return cleared;
    },
    forgetTicket(reference: string) {
      const removed = forgetTicket(reference);
      refresh();
      return removed;
    },
  };
}
