"use client";

import { useState } from "react";
import type { CampusCorridor, CampusDriver, CampusVehicle, CampusZone } from "@/lib/campus-ride";

type CampusData = { zones: CampusZone[]; corridors: CampusCorridor[]; vehicles: CampusVehicle[]; drivers: CampusDriver[] };

export function CampusAdminControlPanel({ initialData }: { initialData: CampusData }) {
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");

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
      <form action={(formData)=>submit("zone", formData)} className="campus-crud-card">
        <h3>Add zone</h3>
        <input name="name" placeholder="Zone name" required />
        <input name="landmark" placeholder="Landmark" />
        <input name="description" placeholder="Description" />
        <div className="campus-inline-fields"><input name="latitude" placeholder="Latitude" /><input name="longitude" placeholder="Longitude" /></div>
        <button disabled={saving==="zone"}>{saving==="zone" ? "Saving..." : "Save zone"}</button>
      </form>

      <form action={(formData)=>submit("corridor", formData)} className="campus-crud-card">
        <h3>Add corridor & fare</h3>
        <input name="name" placeholder="Main Gate → Lecture Area" required />
        <select name="originZoneId" required>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <select name="destinationZoneId" required>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <div className="campus-inline-fields"><input name="estimatedMinutes" type="number" min="1" placeholder="Minutes" defaultValue="10" /><input name="fare" type="number" min="0" step="0.01" placeholder="Fare GHS" defaultValue="5" /></div>
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
