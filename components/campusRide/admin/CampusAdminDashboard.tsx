"use client";

import { useEffect, useState } from "react";
import { CampusOverviewMetrics, LiveRideMonitorWidget } from "@/components/campusRide/admin/AdminCampusWidgets";
import { CampusAdminControlPanel } from "@/components/campusRide/admin/CampusAdminControlPanel";
import { CampusAiAssistant } from "@/components/campusRide/shared/CampusAiAssistant";
import { CampusMap } from "@/components/campusRide/shared/CampusMap";
import { CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";
import type { CampusCorridor, CampusDriver, CampusRide, CampusVehicle, CampusZone } from "@/lib/campus-ride";

type CampusAdminData = {
  zones: CampusZone[];
  corridors: CampusCorridor[];
  vehicles: CampusVehicle[];
  drivers: CampusDriver[];
  rides: CampusRide[];
};

const emptyData: CampusAdminData = {
  zones: [],
  corridors: [],
  vehicles: [],
  drivers: [],
  rides: [],
};

export function CampusAdminDashboard() {
  const [data, setData] = useState<CampusAdminData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/admin/campus/overview", { cache: "no-store", credentials: "same-origin" });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "CampusRide admin data could not be loaded.");
        if (active) setData({ ...emptyData, ...json });
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "CampusRide admin data could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, []);

  if (loading) {
    return <CampusStatusBanner title="Loading campusRide console" message="Checking the authenticated admin API before loading zones, drivers, vehicles, rides, and queues." />;
  }

  if (error) {
    return <CampusStatusBanner title="CampusRide admin data unavailable" message={error} />;
  }

  return <>
    <CampusStatusBanner title="campusRide operations active" message="Manage zones, corridors, vehicles, drivers, live rides, paid queues, maps, and AI help from this console." />
    <CampusOverviewMetrics zones={data.zones} rides={data.rides} drivers={data.drivers} vehicles={data.vehicles} />
    <CampusAdminControlPanel initialData={{ zones:data.zones, corridors:data.corridors, vehicles:data.vehicles, drivers:data.drivers }} />
    <section className="campus-two-column">
      <div>
        <CampusMap zones={data.zones} rides={data.rides} title="Admin live campus map" />
        <LiveRideMonitorWidget rides={data.rides} />
      </div>
      <div>
        <section className="campus-panel">
          <div><p>ZONES</p><h2>Pickup/drop-off zones</h2></div>
          {data.zones.map((zone)=><article key={zone.id} className="campus-list-row"><strong>{zone.name}</strong><span>{zone.landmark || zone.description}</span></article>)}
        </section>
        <CampusAiAssistant area="admin" context={`Zones: ${data.zones.length}\nRides: ${data.rides.length}\nDrivers: ${data.drivers.length}\nVehicles: ${data.vehicles.length}`} />
      </div>
    </section>
  </>;
}
