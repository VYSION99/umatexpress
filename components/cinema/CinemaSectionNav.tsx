import Link from "next/link";
import { CreditCard, FilmSlate, UsersThree } from "@/components/ui/MaterialIcon";
import "./cinema.css";

export function CinemaSectionNav({ current }: { current: "events" | "rooms" | "plans" }) {
  return <nav className="cinema-section-nav" aria-label="Cinema sections">
    <Link href="/cinema" aria-current={current === "events" ? "page" : undefined}>
      <FilmSlate size={20} aria-hidden />
      <span><strong>Events</strong><small>Campus streams and replays</small></span>
    </Link>
    <Link href="/cinema/rooms" aria-current={current === "rooms" ? "page" : undefined}>
      <UsersThree size={20} aria-hidden />
      <span><strong>Watch rooms</strong><small>Smaller spaces with your group</small></span>
    </Link>
    <Link href="/cinema/rooms/plans" aria-current={current === "plans" ? "page" : undefined}>
      <CreditCard size={20} aria-hidden />
      <span><strong>Room plans</strong><small>Compare limits and subscribe</small></span>
    </Link>
  </nav>;
}
