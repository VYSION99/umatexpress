import { CampusShell, CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";
import { CampusRideResults } from "@/components/campusRide/student/CampusRideResults";
import { DepartureBoard } from "@/components/campusRide/student/DepartureBoard";
import { getCampusData } from "@/lib/campus-ride";
import { findNearestCampusRides } from "@/lib/campus-matching";

function numericParam(value?: string) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export default async function CampusPage({ searchParams }: { searchParams?: Promise<{ pickupZoneId?: string; destinationZoneId?: string; pickupLatitude?: string; pickupLongitude?: string }> }) {
  const params = await searchParams;
  const data = await getCampusData();
  const pickupZoneId = params?.pickupZoneId || data.zones[0]?.id || "";
  const destinationZoneId = params?.destinationZoneId || data.corridors.find((corridor)=>corridor.originZoneId===pickupZoneId)?.destinationZoneId || "";
  const pickupLatitude = numericParam(params?.pickupLatitude);
  const pickupLongitude = numericParam(params?.pickupLongitude);
  const matches = findNearestCampusRides({ ...data, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude });
  const selectedPickup = data.zones.find((zone)=>zone.id===pickupZoneId)?.name || "your pickup zone";
  const selectedDestination = data.zones.find((zone)=>zone.id===destinationZoneId)?.name || "your destination";
  const pickupLabel = pickupLatitude !== undefined && pickupLongitude !== undefined ? "your current location" : selectedPickup;

  return <CampusShell area="CAMPUSRIDE" title="Find your nearest campus ride" subtitle="Every route, its fare and the seats open right now — join a queue, pay, and receive an image ticket.">
    <CampusStatusBanner title="Live queue mode" message="Students join ride queues instead of selecting seats. Payment activates the queue ticket." />
    {/* Route-first: the board answers "what is running" before the finder asks
        "where are you going", because that is the order a student asks. */}
    <DepartureBoard corridors={data.corridors} rides={data.rides} zones={data.zones} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} />
    <CampusRideResults zones={data.zones} corridors={data.corridors} matches={matches} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} pickupLatitude={pickupLatitude} pickupLongitude={pickupLongitude} selectedPickup={pickupLabel} selectedDestination={selectedDestination}/>
  </CampusShell>;
}
