"use client";

import { useMemo, useSyncExternalStore } from "react";
import { defaultPreferences, normalizePreferences, type LauncherPreference } from "./services";

const changed = "umatexpress:layout-changed";
const visitLayouts = new Map<string, string>();
function snapshot(storageKey: string) {
  if (visitLayouts.has(storageKey)) return visitLayouts.get(storageKey)!;
  try { return localStorage.getItem(storageKey) || "[]"; }
  catch { return "unavailable"; }
}
function subscribe(storageKey: string, callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) { visitLayouts.delete(storageKey); callback(); }
  };
  window.addEventListener(changed, callback);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(changed, callback); window.removeEventListener("storage", onStorage); };
}
export function useLauncherLayout(storageKey = "umatexpress.launcher.v1", defaults = defaultPreferences, normalize = normalizePreferences) {
  const raw = useSyncExternalStore(callback => subscribe(storageKey, callback), () => snapshot(storageKey), () => null);
  const layout = useMemo(() => {
    if (raw === null) return { preferences: defaults(), error: "" };
    try { return { preferences: normalize(JSON.parse(raw)), error: "" }; }
    catch { return { preferences: defaults(), error: "Saved layout could not be loaded. You can still customise this visit." }; }
  }, [raw, defaults, normalize]);
  function save(preferences: LauncherPreference[]) {
    const visitLayout = JSON.stringify(preferences);
    visitLayouts.set(storageKey, visitLayout);
    let persisted = false;
    try { localStorage.setItem(storageKey, visitLayout); persisted = true; } catch { /* Keep this visit usable when storage is blocked. */ }
    window.dispatchEvent(new Event(changed));
    return persisted;
  }
  return { ...layout, ready: raw !== null, save };
}
