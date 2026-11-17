import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CampusRideResults } from "@/components/campusRide/student/CampusRideResults";
import { DepartureBoard } from "@/components/campusRide/student/DepartureBoard";
import { getCampusData } from "@/lib/campus-ride";
import { bookableCampusRidesForRoute, findNearestCampusRides } from "@/lib/campus-matching";
import { resolveCampusRouteSelection } from "@/lib/campus-zones";
import "@/components/campusRide/student/campus-ride.css";

export default async function CampusPage({ searchParams }: { searchParams?: Promise<{ pickupZoneId?: string; destinationZoneId?: string; rideId?: string }> }) {
  const params = await searchParams;
  const data = await getCampusData();
  const selected = resolveCampusRouteSelection({ ...data, pickupZoneId: params?.pickupZoneId, destinationZoneId: params?.destinationZoneId });
  const { zones, corridors, pickupZoneId, destinationZoneId } = selected;
  const publicRides = bookableCampusRidesForRoute({ rides: data.rides, corridors });
  const routeRides = bookableCampusRidesForRoute({ rides: publicRides, corridors, pickupZoneId, destinationZoneId });
  const matches = findNearestCampusRides({ zones, corridors, rides: routeRides, pickupZoneId, destinationZoneId, limit: routeRides.length || 1 });
  const selectedPickup = zones.find((zone)=>zone.id===pickupZoneId)?.name || "your pickup zone";
  const selectedDestination = zones.find((zone)=>zone.id===destinationZoneId)?.name || "your destination";

  return <CampusShell area="CAMPUSRIDE" title="Find a campus ride" subtitle="Choose a route, compare available rides and fares, then join its queue.">
    {/* Route-first: the board answers "what is running" before the finder asks
        "where are you going", because that is the order a student asks. */}
    <DepartureBoard corridors={corridors} rides={publicRides} zones={zones} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} />
    <CampusRideResults zones={zones} corridors={corridors} rides={routeRides} initialMatches={matches} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} requestedRideId={params?.rideId || ""} selectedPickup={selectedPickup} selectedDestination={selectedDestination}/>
  </CampusShell>;
}
