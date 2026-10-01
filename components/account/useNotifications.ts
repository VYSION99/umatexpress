"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";

export type FeedNotification = {
  id: string;
  template: string;
  subject: string;
  message: string;
  reference: string;
  createdAt: string;
  read: boolean;
};

type FeedSnapshot = { ready: boolean; items: FeedNotification[]; unread: number; error: string };

/**
 * The in-app notification feed, shared by every consumer on the page.
 *
 * The list is small and read on the home screen, so it is fetched once per page
 * load and published module-side: the bell badge and the panel cannot drift
 * apart, and opening the panel does not ask the server a second time. The
 * server holds the read state, so a reload is the source of truth.
 */
let snapshot: FeedSnapshot = { ready: false, items: [], unread: 0, error: "" };
let inFlight: Promise<void> | null = null;
const listeners = new Set<(next: FeedSnapshot) => void>();

function publish(next: FeedSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener(next);
}

// The snapshot is a stable object that only `publish` replaces, so React can
// compare it by identity between renders.
function subscribeToFeed(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function currentFeed() {
  return snapshot;
}

export function refreshNotifications() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch("/api/notifications", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Notifications are unavailable.");
      const data = await response.json() as { notifications?: FeedNotification[]; unread?: number };
      const items = Array.isArray(data.notifications) ? data.notifications : [];
      publish({ ready: true, items, unread: Number(data.unread ?? items.filter(item => !item.read).length), error: "" });
    } catch {
      publish({ ...snapshot, ready: true, error: "Could not load updates. Try again." });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Signing out must not leave the previous student's messages in memory. */
export function clearNotifications() {
  if (!snapshot.ready && !snapshot.items.length) return;
  publish({ ready: false, items: [], unread: 0, error: "" });
}

export function useNotifications() {
  const { ready: accountReady, account } = useStudentAccount();
  const state = useSyncExternalStore(subscribeToFeed, currentFeed, currentFeed);

  useEffect(() => {
    // Wait for the account answer: a fresh mount reports "not ready yet" before
    // it reports "nobody signed in", and clearing on that would wipe the cached
    // feed every time the panel opens.
    if (!accountReady) return;
    if (!account) { clearNotifications(); return; }
    void refreshNotifications();
    const onFocus = () => void refreshNotifications();
    const onVisible = () => { if (!document.hidden) void refreshNotifications(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => { if (!document.hidden) void refreshNotifications(); }, 60_000);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); window.clearInterval(timer); };
  }, [accountReady, account]);

  const markAllRead = async () => {
    if (!state.unread) return;
    publish({ ...state, unread: 0, items: state.items.map((item) => ({ ...item, read: true })) });
    try {
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!response.ok) throw new Error("Could not save read state.");
    } catch {
      publish({ ...state, error: "Could not mark updates as read." });
    }
  };

  return {
    ready: state.ready,
    signedIn: Boolean(account),
    items: state.items,
    unread: state.unread,
    error: state.error,
    refresh: refreshNotifications,
    markAllRead,
  };
}
