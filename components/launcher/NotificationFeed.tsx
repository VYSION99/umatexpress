"use client";

import Link from "next/link";
import { ArrowRight, Bell, Check } from "lucide-react";
import { ticketKindForTemplate } from "@/lib/campus-engine/notify-templates";
import { ticketHref } from "@/lib/passenger-profile";
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
  const { ready, signedIn, items, unread, markAllRead } = useNotifications();

  if (!signedIn) return <div className="launch-panel-message">
    <Bell size={32} aria-hidden />
    <h3>Sign in to see your ride updates.</h3>
    <p>Driver accepted, driver arrived and trip complete messages are sent to your student account and collected here. One UMaT account covers campusRide and vacationRide.</p>
    <Link href="/account?next=%2F">Sign in →</Link>
  </div>;

  if (!ready) return <div className="launch-panel-message">
    <Bell size={32} aria-hidden />
    <h3>Checking for updates…</h3>
  </div>;

  if (!items.length) return <div className="launch-panel-message">
    <Bell size={32} aria-hidden />
    <h3>No ride updates yet.</h3>
    <p>Join a campusRide queue and every step — driver accepted, arrived, trip complete — lands here and in your inbox.</p>
  </div>;

  return <div className="feed">
    <div className="feed-head">
      <span>{items.length} message{items.length === 1 ? "" : "s"}{unread ? ` · ${unread} unread` : ""}</span>
      {unread > 0 && <button className="feed-read-all" onClick={() => void markAllRead()}><Check size={15} aria-hidden /> Mark all read</button>}
    </div>
    <ul>
      {items.map((item) => <li key={item.id} className={item.read ? "" : "is-unread"}>
        <div className="feed-item-head">
          <strong>{item.subject}</strong>
          <small>{relativeTime(item.createdAt)}</small>
        </div>
        <p>{item.message}</p>
        {item.reference && <Link href={ticketHref({ reference: item.reference, kind: ticketKindForTemplate(item.template) })}>Open ticket<ArrowRight size={14} aria-hidden /></Link>}
      </li>)}
    </ul>
  </div>;
}
