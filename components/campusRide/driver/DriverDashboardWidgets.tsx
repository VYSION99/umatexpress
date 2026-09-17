import type { CampusDriver, CampusRide, CampusZone } from "@/lib/campus-ride";

export function DriverStatusCard({ driver, zones }: { driver: CampusDriver; zones: CampusZone[] }) {
  const zone = zones.find((item) => item.id === driver.currentZoneId);
  return <section className="campus-widget-card"><p>DRIVER STATUS</p><h2>{driver.name}</h2><span>{driver.active ? "Active" : "Inactive"} · {zone?.name || "No zone selected"}</span></section>;
}

export function ActiveRideControl({ ride }: { ride?: CampusRide }) {
  return <section className="campus-widget-card"><p>ACTIVE RIDE</p><h2>{ride?.status || "No ride open"}</h2><span>{ride ? `${ride.availableSlots}/${ride.capacity} slots available` : "Open a ride when ready to accept campus passengers."}</span><div className="campus-button-row"><button>Open ride</button><button>Pause</button><button>End</button></div></section>;
}

