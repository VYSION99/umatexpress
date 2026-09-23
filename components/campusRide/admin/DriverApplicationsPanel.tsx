"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, ShieldAlert, UserRoundCheck, X } from "lucide-react";

type DriverApplication = {
  id: string; name: string; phone: string; email: string;
  applicationStatus: string; reviewReason: string; active: boolean;
  vehicleId: string; currentZoneId: string; accountStatus: string; createdAt: string;
};

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const badge = (status: string) => `console-badge console-badge-${status.toLowerCase()}`;

/**
 * Driver applications, on the page that already runs drivers.
 *
 * Driving was the last role only operations could create, so a candidate had to
 * reach a person before they could even apply. They register themselves now and
 * this queue is where the decision is made: approving opens the console and
 * makes the driver active, which is still not the road — operations assigns the
 * vehicle, zone and corridor below, exactly as it does for a driver added by
 * hand.
 */
export function DriverApplicationsPanel() {
  const [drivers, setDrivers] = useState<DriverApplication[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/campus/drivers", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Driver applications could not be loaded.");
      setDrivers(data.drivers || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Driver applications could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  async function decide(driver: DriverApplication, action: "APPROVE" | "REJECT" | "SUSPEND") {
    setBusy(`${driver.id}-${action}`); setError(""); setSaved("");
    try {
      const response = await fetch("/api/console/campus/drivers", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driverId: driver.id, action, reason: reasons[driver.id] || "" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "That decision could not be saved.");
      setSaved(action === "APPROVE"
        ? `${driver.name} can sign in. Assign a vehicle and zone below to put them on the road.`
        : `${driver.name} was ${action === "REJECT" ? "told what to fix" : "suspended and taken off the road"}.`);
      setReasons((current) => ({ ...current, [driver.id]: "" }));
      await load();
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "That decision could not be saved.");
    } finally {
      setBusy("");
    }
  }

  const applicants = (drivers || []).filter((driver) => driver.applicationStatus === "PENDING" || driver.applicationStatus === "REJECTED");
  const operating = (drivers || []).filter((driver) => driver.applicationStatus === "APPROVED" || driver.applicationStatus === "SUSPENDED");

  return <section className="campus-admin-control">
    <div className="campus-admin-control-head">
      <div>
        <p>DRIVER APPLICATIONS</p>
        <h2>Who may sign in and drive</h2>
      </div>
      <button type="button" onClick={() => void load()} disabled={busy === "refresh"}>
        <RefreshCw size={15} />Refresh
      </button>
    </div>
    {saved && <small className="campus-admin-message">{saved}</small>}
    {error && <small className="campus-admin-error">{error}</small>}

    <section className="console-panel">
      <h2><UserRoundCheck size={18}/>Waiting on a decision
        {drivers && <span className="console-badge">{applicants.length}</span>}
      </h2>
      {!drivers
        ? <p className="console-empty">Loading driver applications…</p>
        : applicants.length === 0
          ? <p className="console-empty">No driver applications are waiting. Someone applying at /console/register/driver lands here.</p>
          : <table className="console-table">
            <thead><tr><th>Applicant</th><th>Contact</th><th>Applied</th><th>Decision</th></tr></thead>
            <tbody>
              {applicants.map((driver) => <tr key={driver.id}>
                <td>
                  <strong>{driver.name}</strong>
                  <small className={badge(driver.applicationStatus)}>{driver.applicationStatus}</small>
                </td>
                <td>
                  <span>{driver.phone}</span>
                  <small>{driver.email || "no email on file"}</small>
                </td>
                <td>
                  <span>{when(driver.createdAt)}</span>
                  {driver.reviewReason && <small>{driver.reviewReason}</small>}
                </td>
                <td className="console-row-actions">
                  <input
                    type="text"
                    aria-label={`Reason for ${driver.name}`}
                    placeholder="Reason (needed to reject)"
                    maxLength={200}
                    value={reasons[driver.id] || ""}
                    onChange={(event) => setReasons({ ...reasons, [driver.id]: event.target.value })}
                  />
                  <button type="button" disabled={busy === `${driver.id}-APPROVE`} onClick={() => void decide(driver, "APPROVE")}>
                    <Check size={15} />Approve
                  </button>
                  <button type="button" disabled={busy === `${driver.id}-REJECT`} onClick={() => void decide(driver, "REJECT")}>
                    <X size={15} />Reject
                  </button>
                </td>
              </tr>)}
            </tbody>
          </table>}
      <p className="console-note">
        Approving activates the driver record and opens the console, and the applicant is told by email. A rejection needs a reason so they know what to fix.
      </p>
    </section>

    <section className="console-panel">
      <h2><ShieldAlert size={18}/>Drivers
        {drivers && <span className="console-badge">{operating.length}</span>}
      </h2>
      {!drivers
        ? <p className="console-empty">Loading drivers…</p>
        : operating.length === 0
          ? <p className="console-empty">No drivers have been approved yet.</p>
          : <table className="console-table">
            <thead><tr><th>Driver</th><th>Assignment</th><th>State</th><th></th></tr></thead>
            <tbody>
              {operating.map((driver) => <tr key={driver.id}>
                <td><strong>{driver.name}</strong><small>{driver.email || driver.phone}</small></td>
                <td>
                  <span>{driver.vehicleId ? "Vehicle assigned" : "No vehicle yet"}</span>
                  <small>{driver.currentZoneId ? "Zone set" : "No current zone"}</small>
                </td>
                <td>
                  <span className={badge(driver.applicationStatus)}>{driver.applicationStatus}</span>
                  {driver.reviewReason && <small>{driver.reviewReason}</small>}
                </td>
                <td className="console-row-actions">
                  {driver.applicationStatus === "APPROVED"
                    ? <>
                      <input
                        type="text"
                        aria-label={`Reason for suspending ${driver.name}`}
                        placeholder="Reason to suspend"
                        maxLength={200}
                        value={reasons[driver.id] || ""}
                        onChange={(event) => setReasons({ ...reasons, [driver.id]: event.target.value })}
                      />
                      <button type="button" disabled={busy === `${driver.id}-SUSPEND`} onClick={() => void decide(driver, "SUSPEND")}>
                        <ShieldAlert size={15} />Suspend
                      </button>
                    </>
                    : <span className="console-note">Suspended. Approve to reinstate them.</span>}
                </td>
              </tr>)}
            </tbody>
          </table>}
      <p className="console-note">
        Suspending closes the sign-in, ends any ride they had open and takes them off the map. Approving again reinstates them.
      </p>
    </section>
  </section>;
}
