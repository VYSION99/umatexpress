"use client";

import { useState } from "react";
import { cedis } from "@/lib/campus-fare-math";
import type { CampusFareReport, CampusFareReportRow } from "@/lib/campus-engine/fares";
import type { CampusCorridor, CampusDriver, CampusVehicle, CampusZone } from "@/lib/campus-ride";
import "./campus-admin-zones.css";

type CampusData = { zones: CampusZone[]; corridors: CampusCorridor[]; vehicles: CampusVehicle[]; drivers: CampusDriver[]; fareReport?: CampusFareReport };

/**
 * How a corridor reads at a glance. `UNCHECKED` is deliberately separate from
 * `OK`: a fare saved before the guardrails existed was never measured, and
 * calling that "inside the band" would be a claim the row cannot support.
 */
const FARE_STATUS_LABEL: Record<CampusFareReportRow["status"], string> = {
  OK: "Inside band",
  UNCHECKED: "Not checked",
  BELOW_FLOOR: "Below floor",
  ABOVE_CEILING: "Above ceiling",
  OUT_OF_RANGE: "Outside range",
  UNPRICED: "No fare set",
};

function fareRowDetail(row: CampusFareReportRow) {
  if (row.status === "BELOW_FLOOR") return `Every seat sold loses ${cedis(row.perSeatLoss)}.`;
  if (row.message) return row.message;
  if (row.status === "UNCHECKED") return "Re-save this corridor to record the floor and ceiling it is priced against.";
  return `Driver keeps ${cedis(row.driverSurplus)} a departure · platform ${cedis(row.platformMargin)}.`;
}

export function CampusAdminControlPanel({ initialData }: { initialData: CampusData }) {
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [editingZoneId, setEditingZoneId] = useState("");
  const editingZone = data.zones.find((zone) => zone.id === editingZoneId);

  const refresh = async () => {
    const response = await fetch("/api/admin/campus/manage", { credentials:"same-origin", cache:"no-store" });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "campusRide data could not be refreshed.");
    setData(json);
  };

  const submit = async (resource: string, formData: FormData) => {
    setSaving(resource); setError(""); setMessage("");
    try {
      const payload = Object.fromEntries(formData.entries());
      const response = await fetch("/api/admin/campus/manage", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify({ resource, payload }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "campusRide item could not be saved.");
      await refresh();
      setMessage(`${resource} saved.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "campusRide item could not be saved.");
    } finally {
      setSaving("");
    }
  };

  const resetDriverPassword = async (driverId: string) => {
    setSaving(`driver-password-${driverId}`); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/campus/manage", {
        method:"POST",
        credentials:"same-origin",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({ resource:"driverPassword", payload:{ driverId } }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Driver password could not be reset.");
      await refresh();
      setMessage(`Driver password reset. Temporary password: ${json.item?.temporaryPassword || "Driver@12345"}`);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Driver password could not be reset.");
    } finally {
      setSaving("");
    }
  };

  return <section className="campus-admin-control">
    <div className="campus-admin-control-head"><div><p>ADMIN CRUD</p><h2>Campus setup widgets</h2></div><button onClick={()=>refresh().catch((refreshError)=>setError(refreshError.message))}>Refresh</button></div>
    {message && <small className="campus-admin-message">{message}</small>}
    {error && <small className="campus-admin-error">{error}</small>}
    <div className="campus-crud-grid">
      <form key={editingZoneId || "new-zone"} action={(formData)=>submit("zone", formData)} className="campus-crud-card campus-zone-form">
        <div className="campus-zone-form-head"><h3>{editingZone ? `Edit ${editingZone.name}` : "Add pickup or destination zone"}</h3>{editingZone && <button type="button" onClick={() => setEditingZoneId("")}>New zone</button>}</div>
        {editingZone && <input type="hidden" name="id" value={editingZone.id} />}
        <label>Zone name<input name="name" placeholder="Zone name" defaultValue={editingZone?.name || ""} required /></label>
        <label>Pickup landmark<input name="landmark" placeholder="Recognisable meeting point" defaultValue={editingZone?.landmark || ""} /></label>
        <label>Description<input name="description" placeholder="Where students should wait" defaultValue={editingZone?.description || ""} /></label>
        <div className="campus-inline-fields"><label>Latitude<input name="latitude" type="number" min="-90" max="90" step="any" placeholder="5.3018" defaultValue={editingZone?.latitude ?? ""} required /></label><label>Longitude<input name="longitude" type="number" min="-180" max="180" step="any" placeholder="-1.9931" defaultValue={editingZone?.longitude ?? ""} required /></label></div>
        <small>Use the meeting point coordinates. Both coordinates are required for student routes and maps.</small>
        <button disabled={saving==="zone"}>{saving==="zone" ? "Saving..." : editingZone ? "Update zone" : "Save zone"}</button>
      </form>

      <form action={(formData)=>submit("corridor", formData)} className="campus-crud-card">
        <h3>Add corridor & fare</h3>
        <input name="name" placeholder="Main Gate → Lecture Area" required />
        <select name="originZoneId" required>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <select name="destinationZoneId" required>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <div className="campus-inline-fields"><input name="estimatedMinutes" type="number" min="1" placeholder="Minutes" defaultValue="10" /><input name="distanceKm" type="number" min="0" step="0.1" placeholder="Distance km, one way" /></div>
        <input name="fare" type="number" min="0" step="0.01" placeholder="Fare GHS" defaultValue="5" />
        <input name="plannedSeats" type="number" min="0" placeholder="Seats sold per departure (blank = platform plan)" />
        <small className="campus-fare-hint">The fare is checked against the floor and ceiling below before it is saved. Naming the seats a departure sells is how a longer run on a bigger vehicle lowers its own floor.</small>
        <label className="campus-fare-ack"><input name="acknowledgeBelowFloor" type="checkbox" /> Save anyway if the fare is below the floor</label>
        <button disabled={saving==="corridor"}>{saving==="corridor" ? "Saving..." : "Save corridor"}</button>
      </form>

      <form action={(formData)=>submit("vehicle", formData)} className="campus-crud-card">
        <h3>Add vehicle</h3>
        <input name="label" placeholder="Campus Shuttle 3" required />
        <input name="plateNumber" placeholder="Plate number" />
        <input name="vehicleType" placeholder="Vehicle type" defaultValue="Shuttle" />
        <input name="capacity" type="number" min="1" placeholder="Capacity" defaultValue="4" />
        <button disabled={saving==="vehicle"}>{saving==="vehicle" ? "Saving..." : "Save vehicle"}</button>
      </form>

      <form action={(formData)=>submit("driver", formData)} className="campus-crud-card">
        <h3>Add driver</h3>
        <input name="name" placeholder="Driver name" required />
        <input name="phone" placeholder="Phone" required />
        <input name="email" placeholder="Email or username" />
        <select name="vehicleId"><option value="">No vehicle yet</option>{data.vehicles.map((vehicle)=><option key={vehicle.id} value={vehicle.id}>{vehicle.label}</option>)}</select>
        <select name="currentZoneId"><option value="">No current zone</option>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <button disabled={saving==="driver"}>{saving==="driver" ? "Saving..." : "Save driver"}</button>
      </form>
    </div>
    <section className="campus-zone-directory" aria-labelledby="campus-zone-directory-title">
      <div><h3 id="campus-zone-directory-title">Zone directory</h3><span>{data.zones.length} active {data.zones.length === 1 ? "zone" : "zones"}</span></div>
      <ul>{data.zones.map((zone) => <li key={zone.id}><div><strong>{zone.name}</strong><span>{zone.landmark || "No landmark"} · {zone.latitude ?? "No latitude"}, {zone.longitude ?? "No longitude"}</span></div><button type="button" onClick={() => setEditingZoneId(zone.id)}>Edit coordinates</button></li>)}</ul>
    </section>
    {data.fareReport && <section className="campus-fare-guard">
      <div className="campus-fare-guard-head">
        <div><p>FARE GUARDRAILS</p><h3>Floor and ceiling by corridor</h3></div>
        <span className="campus-fare-guard-summary">
          {data.fareReport.summary.belowFloor} below floor · {data.fareReport.summary.unchecked} unchecked · {(data.fareReport.summary.commissionBps / 100).toFixed(0)}% commission
        </span>
      </div>
      <p className="campus-fare-guard-caveat">{data.fareReport.note}</p>
      <p className="campus-fare-guard-costs">
        Cost model: {cedis(data.fareReport.policy.costPerKm)} a km · {cedis(data.fareReport.policy.costPerMinute)} a minute · {cedis(data.fareReport.policy.standingCost)} a departure · {data.fareReport.policy.assumedSeats} seats at {(data.fareReport.policy.loadFactorBps / 100).toFixed(0)}% loads · {(data.fareReport.policy.maxMarkupBps / 100).toFixed(0)}% markup ceiling
      </p>
      {!data.fareReport.rows.length ? <span>No corridors have been created yet.</span> : <div className="campus-fare-guard-rows">
        {data.fareReport.rows.map((row) => <article key={row.corridorId}>
          <div>
            <strong>{row.corridor}</strong>
            <span>{cedis(row.fare)} fare · {cedis(row.floor)} floor · {cedis(row.ceiling)} ceiling · {row.distanceKm ? `${row.distanceKm} km` : "no distance recorded"} · {row.minutes} min · {row.plannedSeats} seats {row.plannedSeatsOverride ? "(corridor plan)" : "(platform plan)"}</span>
          </div>
          <span className={`campus-fare-guard-chip is-${row.status.toLowerCase()}`}>{FARE_STATUS_LABEL[row.status]}</span>
          <small>{fareRowDetail(row)}</small>
        </article>)}
      </div>}
    </section>}

    <section className="campus-driver-security-list">
      <div><p>DRIVER SECURITY</p><h3>Password resets</h3></div>
      {!data.drivers.length ? <span>No drivers have been created yet.</span> : data.drivers.map((driver) => <article key={driver.id}>
        <div>
          <strong>{driver.name}</strong>
          <span>{driver.email || driver.phone} · {driver.mustChangePassword ? "Temporary password active" : "Password changed"}</span>
        </div>
        <button type="button" disabled={saving===`driver-password-${driver.id}`} onClick={()=>resetDriverPassword(driver.id)}>
          {saving===`driver-password-${driver.id}` ? "Resetting..." : "Reset password"}
        </button>
      </article>)}
    </section>
  </section>;
}
