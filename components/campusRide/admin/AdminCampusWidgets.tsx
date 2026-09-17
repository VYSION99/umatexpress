import type { CampusDriver, CampusRide, CampusVehicle, CampusZone } from "@/lib/campus-ride";

export function CampusOverviewMetrics({ zones, rides, drivers, vehicles }: { zones: CampusZone[]; rides: CampusRide[]; drivers: CampusDriver[]; vehicles: CampusVehicle[] }) {
  return <section className="campus-metric-grid">
    <article><span>Zones</span><strong>{zones.length}</strong></article>
    <article><span>Live rides</span><strong>{rides.length}</strong></article>
    <article><span>Drivers</span><strong>{drivers.length}</strong></article>
    <article><span>Vehicles</span><strong>{vehicles.length}</strong></article>
  </section>;
}

export function LiveRideMonitorWidget({ rides }: { rides: CampusRide[] }) {
  return <section className="campus-panel"><div><p>LIVE RIDES</p><h2>Ride monitor</h2></div>{rides.map((ride)=><article key={ride.id} className="campus-list-row"><strong>{ride.vehicleLabel}</strong><span>{ride.driverName} · {ride.status} · {ride.availableSlots} slots</span></article>)}</section>;
}

