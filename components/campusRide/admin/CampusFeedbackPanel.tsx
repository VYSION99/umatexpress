"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, Star } from "@phosphor-icons/react";

type Rating = {
  id: string; reference: string; driverId: string; driverName: string;
  passengerEmail: string; rating: number; comment: string; createdAt: string; updatedAt: string;
};

type DriverAverage = { driverId: string; driverName: string; trips: number; average: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const stars = (score: number) => "★".repeat(Math.max(0, Math.min(5, score))) + "☆".repeat(5 - Math.max(0, Math.min(5, score)));

/**
 * What passengers said, for the person who can do something about it.
 *
 * Ranked worst-first because the only question worth asking of a rating desk is
 * "which runs need a look" — and a table sorted by newest answers a different
 * question. Complaints are deliberately absent: those are disputes, and they
 * are read where a decision can be recorded against them.
 */
export function CampusFeedbackPanel() {
  const [ratings, setRatings] = useState<Rating[] | null>(null);
  const [overall, setOverall] = useState<{ average: number; count: number }>({ average: 0, count: 0 });
  const [byDriver, setByDriver] = useState<DriverAverage[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy("refresh"); setError("");
    try {
      const response = await fetch("/api/console/campus/feedback", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Campus ratings could not be loaded.");
      setRatings(data.ratings || []);
      setOverall(data.overall || { average: 0, count: 0 });
      setByDriver(data.byDriver || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Campus ratings could not be loaded.");
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const comments = (ratings || []).filter((rating) => rating.comment);

  return <section className="campus-admin-control">
    <div className="campus-admin-control-head">
      <div>
        <p>PASSENGER RATINGS</p>
        <h2>What students said about the rides</h2>
      </div>
      <button type="button" onClick={() => void load()} disabled={busy === "refresh"}>
        <ArrowsClockwise size={15} />Refresh
      </button>
    </div>
    {error && <small className="campus-admin-error">{error}</small>}

    <div className="console-stat-row">
      <span><small>Average</small><strong>{overall.count ? overall.average.toFixed(1) : "—"}</strong></span>
      <span><small>Rated trips</small><strong>{overall.count}</strong></span>
      <span><small>Written comments</small><strong>{comments.length}</strong></span>
    </div>

    <section className="console-panel">
      <h2><Star size={18}/>By driver
        {byDriver.length > 0 && <span className="console-badge">{byDriver.length}</span>}
      </h2>
      {!ratings
        ? <p className="console-empty">Loading ratings…</p>
        : byDriver.length === 0
          ? <p className="console-empty">No student has rated a trip yet. A rating appears on a completed ticket.</p>
          : <table className="console-table">
            <thead><tr><th>Driver</th><th>Average</th><th>Rated trips</th></tr></thead>
            <tbody>
              {byDriver.map((driver) => <tr key={driver.driverId || driver.driverName}>
                <td><strong>{driver.driverName}</strong></td>
                {/* Two trips are not a verdict, so the weakest runs are only
                    flagged once there is enough of a record to mean something. */}
                <td><strong className={driver.trips >= 3 && driver.average < 3 ? "console-danger-text" : ""}>{driver.average.toFixed(1)}</strong><small>{stars(Math.round(driver.average))}</small></td>
                <td><span>{driver.trips}</span>{driver.trips < 3 && <small>too few to read as a verdict</small>}</td>
              </tr>)}
            </tbody>
          </table>}
      <p className="console-note">
        Sorted by weakest average first. A complaint is not here on purpose: reports from the ticket land in the dispute queue, where a decision can be recorded against them.
      </p>
    </section>

    <section className="console-panel">
      <h2><Star size={18}/>What they wrote</h2>
      {!ratings
        ? <p className="console-empty">Loading comments…</p>
        : comments.length === 0
          ? <p className="console-empty">No written comments yet — most students only tap a score.</p>
          : <table className="console-table">
            <thead><tr><th>Ride</th><th>Driver</th><th>Score</th><th>Comment</th></tr></thead>
            <tbody>
              {comments.slice(0, 40).map((rating) => <tr key={rating.id}>
                <td><strong>{rating.reference}</strong><small>{when(rating.updatedAt || rating.createdAt)}</small></td>
                <td><span>{rating.driverName || "Unassigned"}</span><small>{rating.passengerEmail}</small></td>
                <td><span>{stars(rating.rating)}</span></td>
                <td><span className="console-note">{rating.comment}</span></td>
              </tr>)}
            </tbody>
          </table>}
    </section>
  </section>;
}
