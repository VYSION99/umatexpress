"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRinging, Car, CheckCircle, CircleNotch, Clock, MapPin } from "@phosphor-icons/react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CampusCorridor, CampusRide, CampusZone } from "@/lib/campus-ride";
import { readProfile } from "@/lib/passenger-profile";

const cedis = (pesewas: number) => `GH₵ ${(Math.max(0, Number(pesewas) || 0) / 100).toFixed(2)}`;

type WatchState = "idle" | "working" | "done" | "error";

/**
 * The departure board.
 *
 * A student arrives thinking in routes — "I need the hostel run", not "I need
 * to describe a journey in two dropdowns". So this is the first thing on the
 * page: every route, what it costs, how long it takes, and how many seats are
 * open right now. Tapping a route fills the finder below, which is the
 * route-first entry the search form could never be.
 *
 * The second half of the board is the quiet one. When a route has no seats, the
 * student can ask to be told when one opens, and that promise is kept by the
 * seat-watch sweep rather than by hoping they check again.
 */
export function DepartureBoard({ corridors, rides, zones, pickupZoneId, destinationZoneId }: {
  corridors: CampusCorridor[];
  rides: CampusRide[];
  zones: CampusZone[];
  pickupZoneId: string;
  destinationZoneId: string;
}) {
  const { ready: accountReady, account } = useStudentAccount();
  const [email, setEmail] = useState("");
  const [openWatchFor, setOpenWatchFor] = useState("");
  const [watchState, setWatchState] = useState<Record<string, WatchState>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // A repeat rider should not retype an address they already gave us. The
  // account wins; the device-local profile is the fallback for a guest.
  useEffect(() => {
    queueMicrotask(() => {
      const saved = readProfile();
      setEmail(saved?.email || "");
    });
  }, []);

  const openSeats = useMemo(() => {
    const seats = new Map<string, number>();
    for (const ride of rides) {
      if (String(ride.status).toUpperCase() !== "OPEN" || !ride.acceptingQueue) continue;
      const available = Math.max(0, Number(ride.availableSlots) || 0);
      if (available <= 0) continue;
      seats.set(ride.corridorId, (seats.get(ride.corridorId) || 0) + available);
    }
    return seats;
  }, [rides]);

  // Departures first, in the order a student wants them: what can be ridden now,
  // then the routes that only need a driver to appear.
  const board = useMemo(() => [...corridors]
    .map((corridor) => ({ corridor, seats: openSeats.get(corridor.id) || 0 }))
    .sort((left, right) => right.seats - left.seats || left.corridor.name.localeCompare(right.corridor.name)), [corridors, openSeats]);

  const zoneName = useCallback((id: string) => zones.find((zone) => zone.id === id)?.name || id, [zones]);

  const watch = async (corridorId: string) => {
    setWatchState((current) => ({ ...current, [corridorId]: "working" }));
    setMessage(""); setError("");
    try {
      const response = await fetch("/api/campus/watch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ corridorId, email, source: "board" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "We could not save that request.");
      setWatchState((current) => ({ ...current, [corridorId]: "done" }));
      setMessage(`Watching ${zoneName(corridors.find((item) => item.id === corridorId)?.originZoneId || "")} — we will write to ${data.watch?.email || email} when a seat opens.`);
      setOpenWatchFor("");
    } catch (watchError) {
      setWatchState((current) => ({ ...current, [corridorId]: "idle" }));
      setError(watchError instanceof Error ? watchError.message : "We could not save that request.");
    }
  };

  const canWatch = Boolean(account?.email || email);

  return <section className="departure-board">
    <div className="departure-head">
      <div>
        <p>DEPARTURES</p>
        <h2>Every campus route, right now</h2>
        <span>Open a route to join its queue, or ask to be told when a seat appears.</span>
      </div>
      <span className="departure-total"><Car size={16}/>{rides.filter((ride) => String(ride.status).toUpperCase() === "OPEN").length} riding now</span>
    </div>

    {message && <p className="departure-message"><CheckCircle size={15}/>{message}</p>}
    {error && <p className="departure-error">{error}</p>}

    <ul className="departure-list">
      {/* A board with no routes is a blank card otherwise, which reads as a
          failure rather than a fact about the schedule. */}
      {board.length === 0 && <li className="departure-empty">No campus route is running yet. Once operations opens one it appears here with its fare and its open seats.</li>}
      {board.map(({ corridor, seats }) => {
        const selected = corridor.originZoneId === pickupZoneId && corridor.destinationZoneId === destinationZoneId;
        const state = watchState[corridor.id] || "idle";
        return <li key={corridor.id} className={`departure-row${seats > 0 ? " is-live" : ""}${selected ? " is-selected" : ""}`}>
          <div className="departure-route">
            <strong>{corridor.name}</strong>
            <small><MapPin size={12}/>{zoneName(corridor.originZoneId)} → {zoneName(corridor.destinationZoneId)}</small>
          </div>
          <div className="departure-facts">
            <span><b>{cedis(corridor.fare)}</b><small>flat fare</small></span>
            <span><b><Clock size={13}/>{corridor.estimatedMinutes || "—"} min</b><small>{corridor.distanceKm ? `${corridor.distanceKm} km` : "route time"}</small></span>
          </div>
          <div className="departure-seats">
            {seats > 0
              ? <><b>{seats}</b><small>{seats === 1 ? "seat open" : "seats open"}</small></>
              : <><b className="is-quiet">0</b><small>no seats yet</small></>}
          </div>
          <div className="departure-actions">
            <Link className="departure-join" href={`/campus?pickupZoneId=${encodeURIComponent(corridor.originZoneId)}&destinationZoneId=${encodeURIComponent(corridor.destinationZoneId)}#campus-find`}>
              {seats > 0 ? "Join this queue" : "See this route"}
            </Link>
            {seats === 0 && (state === "done"
              ? <span className="departure-watching"><BellRinging size={14}/>Watching</span>
              : <button type="button" onClick={() => setOpenWatchFor(openWatchFor === corridor.id ? "" : corridor.id)}>
                <BellRinging size={14}/>Notify me
              </button>)}
          </div>
          {openWatchFor === corridor.id && <form className="departure-watch-form" onSubmit={(event) => { event.preventDefault(); void watch(corridor.id); }}>
            <p>Tell me when a seat opens on {corridor.name}.</p>
            {account?.email
              ? <small>We will email {account.email}.</small>
              : <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@student.umat.edu.gh"
                  aria-label="Email address for seat alerts"
                />}
            <div>
              <button type="submit" disabled={!canWatch || state === "working"}>
                {state === "working" ? <><CircleNotch size={14} className="spin"/>Saving…</> : "Watch this route"}
              </button>
              <button type="button" onClick={() => setOpenWatchFor("")}>Not now</button>
            </div>
            {!canWatch && <small className="departure-hint">Add an email address and we will write the moment a driver opens this route.</small>}
          </form>}
        </li>;
      })}
    </ul>

    {!accountReady && <p className="departure-hint">Checking your account…</p>}
    {accountReady && !account && <p className="departure-hint"><Link href="/account?next=%2Fcampus">Sign in</Link> to join a queue and pay; watching a route works without an account.</p>}
  </section>;
}
