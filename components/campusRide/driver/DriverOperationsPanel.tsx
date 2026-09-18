"use client";

import { useCallback, useEffect, useState } from "react";
import { LocateFixed } from "lucide-react";
import { CampusAiAssistant } from "@/components/campusRide/shared/CampusAiAssistant";
import { CampusMap } from "@/components/campusRide/shared/CampusMap";
import type { CampusCorridor, CampusDriver, CampusQueueEntry, CampusRide, CampusVehicle, CampusZone } from "@/lib/campus-ride";

type DriverState = { driver: CampusDriver; ride?: CampusRide; zones: CampusZone[]; corridors: CampusCorridor[]; vehicles: CampusVehicle[] };

type DriverSummary = {
  day: string;
  completed: number;
  boarded: number;
  grossFares: number;
  activeQueue: number;
  nextPickup: { reference: string; queuePosition: number; passengerName: string; pickupZone: string } | null;
};

export function DriverOperationsPanel({ initialData }: { initialData?: DriverState | null }) {
  const [data, setData] = useState<DriverState | null>(initialData || null);
  const [queue, setQueue] = useState<CampusQueueEntry[]>([]);
  const [summary, setSummary] = useState<DriverSummary | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [gpsStatus, setGpsStatus] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");

  const loadQueue = useCallback(async () => {
    const response = await fetch("/api/driver/queue", { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) return;
    const json = await response.json();
    setQueue(json.queue || []);
  }, []);

  const loadSummary = useCallback(async () => {
    const response = await fetch("/api/driver/summary", { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) return;
    setSummary(await response.json());
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/driver/me", { credentials:"same-origin", cache:"no-store" });
    const json = await response.json();
    if (!response.ok) {
      window.location.assign("/driver/login");
      return;
    }
    setData(json);
    await loadQueue();
    await loadSummary();
  }, [loadQueue, loadSummary]);

  useEffect(() => { if (!data) queueMicrotask(load); else queueMicrotask(loadQueue); }, [data, load, loadQueue]);

  const mutate = async (url: string, method: "POST" | "PATCH", payload: Record<string, unknown>, label: string) => {
    setSaving(label); setError("");
    try {
      const response = await fetch(url, { method, credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Driver action failed.");
      if (json.driver) setData(json as DriverState);
      if (Array.isArray(json.queue)) setQueue(json.queue);
      else await load();
      await loadQueue();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Driver action failed.");
    } finally {
      setSaving("");
    }
  };

  const queueAction = async (entry: CampusQueueEntry, action: string) => {
    await mutate("/api/driver/queue", "PATCH", { reference:entry.reference, action, pin:pins[entry.reference] || "" }, action);
  };

  const signOut = async () => {
    await fetch("/api/driver/auth", { method:"DELETE", credentials:"same-origin" });
    window.location.assign("/driver/login");
  };

  const changePassword = async (formData: FormData) => {
    setSaving("password"); setError(""); setPasswordMessage("");
    try {
      const response = await fetch("/api/driver/auth", {
        method:"PATCH",
        credentials:"same-origin",
        headers:{"content-type":"application/json"},
        body:JSON.stringify(Object.fromEntries(formData.entries())),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Driver password could not be changed.");
      setPasswordMessage("Password changed. Use the new password next time you sign in.");
      await load();
    } catch (passwordError) {
      setError(passwordError instanceof Error ? passwordError.message : "Driver password could not be changed.");
    } finally {
      setSaving("");
    }
  };

  const updateFromDeviceGps = () => {
    setGpsStatus("");
    if (!navigator.geolocation) {
      setGpsStatus("GPS is not available on this device.");
      return;
    }
    setSaving("gps");
    navigator.geolocation.getCurrentPosition((position) => {
      mutate("/api/driver/location", "PATCH", {
        currentZoneId: data?.driver.currentZoneId || data?.zones[0]?.id || "",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }, "gps").then(() => setGpsStatus("Live GPS location updated."));
    }, () => {
      setSaving("");
      setGpsStatus("GPS permission was not granted.");
    }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 10000 });
  };

  if (!data) return <main className="admin-auth-check"><span className="spin">◌</span><p>Checking driver access…</p></main>;
  const vehicle = data.vehicles.find((item) => item.id === data.driver.vehicleId);
  const currentZone = data.zones.find((item) => item.id === data.driver.currentZoneId);

  return <section className="campus-two-column">
    <div>
      <section className="campus-widget-card">
        <p>DRIVER STATUS</p>
        <h2>{data.driver.name}</h2>
        <span>{data.driver.active ? "Active" : "Inactive"} · {vehicle?.label || "No vehicle"} · {currentZone?.name || "No zone"}</span>
        {data.driver.mustChangePassword && <small className="campus-warning">Temporary password active. Please change it before operating live rides.</small>}
        <div className="campus-button-row"><button onClick={signOut}>Sign out</button><button onClick={load}>Refresh</button></div>
      </section>

      <section className="campus-widget-card driver-summary-card">
        <p>TODAY</p>
        <h2>{summary?.grossFares ? `GH₵ ${(summary.grossFares / 100).toFixed(2)} collected` : "No completed trips yet"}</h2>
        <span>{summary ? `Since ${summary.day} · refreshed automatically` : "Loading today's totals…"}</span>
        <div className="driver-summary-grid">
          <span>Completed<strong>{summary?.completed ?? 0}</strong></span>
          <span>Boarded<strong>{summary?.boarded ?? 0}</strong></span>
          <span>In queue<strong>{summary?.activeQueue ?? 0}</strong></span>
        </div>
        {summary?.nextPickup && <small className="campus-admin-message">Next pickup: {summary.nextPickup.passengerName} (#{summary.nextPickup.queuePosition}{summary.nextPickup.pickupZone ? ` · ${summary.nextPickup.pickupZone}` : ""})</small>}
      </section>

      <form className="campus-widget-card driver-password-card" action={changePassword}>
        <p>SECURITY</p>
        <h2>Change driver password</h2>
        <span>Use this after first sign-in or anytime an admin resets your account.</span>
        <input name="currentPassword" type="password" autoComplete="current-password" placeholder="Current password" required />
        <input name="newPassword" type="password" autoComplete="new-password" placeholder="New strong password" required />
        <button disabled={saving==="password"}>{saving==="password" ? "Changing..." : "Change password"}</button>
        {passwordMessage && <small className="campus-admin-message">{passwordMessage}</small>}
      </form>

      <form className="campus-widget-card" action={(formData)=>mutate("/api/driver/location", "PATCH", Object.fromEntries(formData.entries()), "location")}>
        <p>LOCATION</p>
        <h2>Current zone</h2>
        <select name="currentZoneId" defaultValue={data.driver.currentZoneId}>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <div className="campus-button-row"><button disabled={saving==="location"}>{saving==="location" ? "Updating..." : "Update zone"}</button><button type="button" disabled={saving==="gps"} onClick={updateFromDeviceGps}><LocateFixed size={16}/>{saving==="gps" ? "Updating GPS..." : "Use device GPS"}</button></div>
        {gpsStatus && <small>{gpsStatus}</small>}
      </form>

      <form className="campus-widget-card" action={(formData)=>mutate("/api/driver/rides", "POST", Object.fromEntries(formData.entries()), "ride")}>
        <p>OPEN RIDE</p>
        <h2>Accept campus requests</h2>
        <select name="corridorId" defaultValue={data.ride?.corridorId || data.corridors[0]?.id}>{data.corridors.map((corridor)=><option key={corridor.id} value={corridor.id}>{corridor.name} · GH₵ {(corridor.fare/100).toFixed(2)}</option>)}</select>
        <select name="currentZoneId" defaultValue={data.driver.currentZoneId}>{data.zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select>
        <input name="capacity" type="number" min="1" defaultValue={vehicle?.capacity || data.ride?.capacity || 4} />
        <button disabled={saving==="ride"}>{saving==="ride" ? "Opening..." : "Open ride"}</button>
      </form>

      <section className="campus-widget-card">
        <p>ACTIVE RIDE</p>
        <h2>{data.ride?.status || "No ride open"}</h2>
        <span>{data.ride ? `${data.ride.availableSlots}/${data.ride.capacity} slots available` : "Open a ride when ready."}</span>
        {data.ride && <div className="campus-button-row">
          <button disabled={saving==="pause"} onClick={()=>mutate("/api/driver/rides", "PATCH", { rideId:data.ride?.id, action:"pause" }, "pause")}>Pause</button>
          <button disabled={saving==="resume"} onClick={()=>mutate("/api/driver/rides", "PATCH", { rideId:data.ride?.id, action:"resume" }, "resume")}>Resume</button>
          <button disabled={saving==="end"} onClick={()=>mutate("/api/driver/rides", "PATCH", { rideId:data.ride?.id, action:"end" }, "end")}>End</button>
        </div>}
      </section>

      <section className="campus-widget-card campus-driver-queue">
        <p>PASSENGER QUEUE</p>
        <h2>Paid waiting passengers</h2>
        {!queue.length ? <span>No paid passengers are waiting for this driver yet.</span> : queue.map((entry) => <article key={entry.reference} className="campus-queue-entry">
          <div>
            <strong>{entry.passengerName}</strong>
            <small>#{entry.queuePosition} · {entry.queueStatus.replace(/_/g, " ")}</small>
          </div>
          <span>{entry.pickupZone || entry.pickupZoneId} → {entry.destinationZone || entry.destinationZoneId}</span>
          <span>{entry.phone} · GH₵ {(entry.amount / 100).toFixed(2)}</span>
          {entry.queueStatus === "DRIVER_ARRIVED" && <input
            inputMode="numeric"
            maxLength={4}
            placeholder="Enter passenger PIN"
            value={pins[entry.reference] || ""}
            onChange={(event)=>setPins((current)=>({ ...current, [entry.reference]:event.target.value.replace(/\D/g, "").slice(0, 4) }))}
          />}
          <div className="campus-button-row">
            {entry.queueStatus === "PAID_WAITING" && <button disabled={saving==="accept"} onClick={()=>queueAction(entry, "accept")}>Accept</button>}
            {entry.queueStatus === "ACCEPTED_BY_DRIVER" && <button disabled={saving==="arrived"} onClick={()=>queueAction(entry, "arrived")}>Mark arrived</button>}
            {entry.queueStatus === "DRIVER_ARRIVED" && <button disabled={saving==="verify-pin"} onClick={()=>queueAction(entry, "verify-pin")}>Verify PIN</button>}
            {entry.queueStatus === "BOARDED" && <button disabled={saving==="complete"} onClick={()=>queueAction(entry, "complete")}>Complete</button>}
            {["ACCEPTED_BY_DRIVER","DRIVER_ARRIVED"].includes(entry.queueStatus) && <button disabled={saving==="no-show"} onClick={()=>queueAction(entry, "no-show")}>No-show</button>}
            {["PAID_WAITING","ACCEPTED_BY_DRIVER","DRIVER_ARRIVED","BOARDED"].includes(entry.queueStatus) && <button disabled={saving==="cancel"} onClick={()=>queueAction(entry, "cancel")}>Cancel</button>}
          </div>
        </article>)}
      </section>
      {error && <p className="campus-admin-error">{error}</p>}
    </div>
    <div>
      <CampusMap zones={data.zones} corridors={data.corridors} rides={data.ride ? [data.ride] : []} title="Driver live map" />
      <CampusAiAssistant area="driver" context={`Driver: ${data.driver.name}\nZone: ${currentZone?.name || "Not set"}\nRide: ${data.ride?.status || "None"}\nAvailable slots: ${data.ride?.availableSlots || 0}`} />
    </div>
  </section>;
}
