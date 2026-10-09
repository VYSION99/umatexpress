"use client";

import Link from "next/link";
import { ArrowRight, Bell, Check } from "@/components/ui/MaterialIcon";
import { notificationAction } from "@/lib/notification-destinations";
import { useNotifications } from "@/components/account/useNotifications";

/** "4m ago" / "Yesterday" / "12 Mar" — short enough for a list row. */
export function relativeTime(value: string, now = Date.now()) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  const minutes = Math.round(Math.max(0, now - parsed) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(parsed).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * The notification panel body. A guest gets the sign-in prompt rather than an
 * empty list, because the feed belongs to the account and not to the device.
 */
export function NotificationFeed() {
  const { ready, signedIn, items, unread, error, refresh, markAllRead } = useNotifications();

  if (!signedIn) return <div className="launch-panel-message">
    <Bell size={32} aria-hidden />
    <h3>Sign in to see your updates.</h3>
    <p>Ride, hostel and cinema updates for your student account appear here.</p>
    <Link href="/account?next=%2F">Sign in →</Link>
  </div>;

  if (!ready) return <div className="launch-panel-message">
    <Bell size={32} aria-hidden />
    <h3>Checking for updates…</h3>
  </div>;

  if (!items.length) return <div className="launch-panel-message">
    <Bell size={32} aria-hidden />
    <h3>{error ? "Updates are unavailable" : "No updates yet."}</h3>
    <p>{error || "When a service has news for you, it will appear here and in your inbox."}</p>
    {error && <button type="button" onClick={() => void refresh()}>Try again</button>}
  </div>;

  return <div className="feed">
    {error && <p role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></p>}
    <div className="feed-head">
      <span>{items.length} message{items.length === 1 ? "" : "s"}{unread ? ` · ${unread} unread` : ""}</span>
      {unread > 0 && <button className="feed-read-all" onClick={() => void markAllRead()}><Check size={15} aria-hidden /> Mark all read</button>}
    </div>
    <ul>
      {items.map((item) => { const action = notificationAction(item.template, item.reference, item.message); return <li key={item.id} className={item.read ? "" : "is-unread"}>
        <div className="feed-item-head">
          <strong>{item.subject}</strong>
          <small>{relativeTime(item.createdAt)}</small>
        </div>
        <p>{item.message}</p>
        {action && <Link href={action.href}>{action.label}<ArrowRight size={14} aria-hidden /></Link>}
      </li>; })}
    </ul>
  </div>;
}
