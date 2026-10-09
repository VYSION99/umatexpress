"use client";

import Link from "next/link";
import { Bell, Check } from "@/components/ui/MaterialIcon";
import { useCallback, useEffect, useState } from "react";
import { notificationAction } from "@/lib/notification-destinations";

type Notice = { id: string; template: string; subject: string; message: string; reference: string; createdAt: string; read: boolean };

export function ConsoleNotifications() {
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/console/notifications", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Updates are unavailable.");
      const data = await response.json() as { notifications?: Notice[]; unread?: number };
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      setUnread(Number(data.unread || 0));
      setError("");
    } catch {
      setError("Could not load updates. Try again.");
    } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const onFocus = () => void refresh();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    return () => { window.clearTimeout(initial); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); window.clearInterval(timer); };
  }, [refresh]);

  const markAllRead = async () => {
    try {
      const response = await fetch("/api/console/notifications", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
      if (!response.ok) throw new Error();
      setItems(current => current.map(item => ({ ...item, read: true })));
      setUnread(0);
    } catch { setError("Could not mark updates as read."); }
  };

  return <details className="console-notifications" onToggle={event => { if (event.currentTarget.open) void refresh(); }}>
    <summary aria-label={unread ? "Notifications, " + unread + " unread" : "Notifications"}><Bell size={18}/>{unread > 0 && <span className="console-notifications-count">{unread}</span>}</summary>
    <div className="console-notifications-panel">
      <div className="console-notifications-heading"><strong>Notifications</strong>{unread > 0 && <button type="button" onClick={() => void markAllRead()}><Check size={14}/> Mark read</button>}</div>
      {error && <p role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></p>}
      {busy && !items.length && <p>Loading updates…</p>}
      {!busy && !items.length && !error && <p>No updates yet.</p>}
      <ul>{items.map(item => {
        const action = notificationAction(item.template, item.reference, item.message);
        return <li key={item.id} className={item.read ? "" : "is-unread"}><strong>{item.subject}</strong><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleString("en-GB")}</small>{action?.href.startsWith("/console") && <Link href={action.href}>{action.label} →</Link>}</li>;
      })}</ul>
    </div>
  </details>;
}
