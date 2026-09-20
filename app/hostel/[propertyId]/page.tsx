import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BedDouble, DoorClosed, MapPin, Zap } from "lucide-react";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { HostelBookButton } from "@/components/campusRide/hostel/HostelBookButton";
import { HostelMap } from "@/components/campusRide/hostel/HostelMap";
import { PropertyAssistant } from "@/components/campusRide/hostel/PropertyAssistant";
import { PropertyReviews } from "@/components/campusRide/hostel/PropertyReviews";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import { getPublicProperty } from "@/lib/hostel-engine/listings";
import { defaultHostelPeriodId, listHostelPeriods } from "@/lib/hostel-engine/periods";

type PageProps = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { propertyId } = await params;
  const record = await getPublicProperty(propertyId);
  if (!record) return { title: "Hostel not found | UMaTeXPRESS" };
  return {
    title: `${record.property.name} | Hostel Finder | UMaTeXPRESS`,
    description: `Approved beds at ${record.property.name}, ${record.property.address || "near UMaT"}.`,
  };
}

/**
 * One hostel, every approved bed. A property that is suspended, unpublished or
 * has no bed on sale in the open year is a 404: the public gate is the same
 * query the map uses, so a page can never outlive the approval behind it.
 */
export default async function HostelPropertyPage({ params, searchParams }: PageProps) {
  const { propertyId } = await params;
  const query = (await searchParams) || {};
  const requestedPeriod = Array.isArray(query.periodId) ? query.periodId[0] : query.periodId;
  const periods = await listHostelPeriods();
  const periodId = periods.some((item) => item.id === requestedPeriod) ? requestedPeriod : defaultHostelPeriodId(periods);
  const record = await getPublicProperty(propertyId, periodId);
  if (!record) notFound();
  const { period, property, spaces, photos } = record;

  const rooms = new Map<string, typeof spaces>();
  spaces.forEach((space) => rooms.set(space.roomLabel, [...(rooms.get(space.roomLabel) || []), space]));
  const cheapest = spaces.reduce((lowest, space) => Math.min(lowest, space.total), Number.POSITIVE_INFINITY);

  return <CampusShell area="HOSTELFINDER" title={property.name} subtitle={`${period.name} · ${bedsLabel(property.availableSpaces)}`}>
    <nav className="hostel-breadcrumb">
      <Link href={`/hostel?periodId=${encodeURIComponent(period.id)}`}><ArrowLeft size={14} aria-hidden /> All hostels</Link>
    </nav>
    <div className="hostel-layout">
      <div className="hostel-main">
        {photos.length > 0 && <section className="hostel-gallery">
          <img className="hostel-gallery-main" src={`/api/hostel/photos/${photos[0].id}`} alt={photos[0].caption || `${property.name} from outside`} />
          {photos.length > 1 && <ul className="hostel-gallery-strip">
            {photos.slice(1).map((photo) => <li key={photo.id}>
              <img src={`/api/hostel/photos/${photo.id}`} alt={photo.caption || `${property.name} photo`} loading="lazy" />
            </li>)}
          </ul>}
        </section>}
        <section className="hostel-detail-card">
          <p>ABOUT THIS HOSTEL</p>
          <h2>{property.address || "Address shared on request"}</h2>
          <ul className="hostel-card-facts">
            <li><MapPin size={12} aria-hidden />{distanceLabel(property.distanceM)}</li>
            <li><DoorClosed size={12} aria-hidden />{property.roomCount} {property.roomCount === 1 ? "room" : "rooms"}</li>
            <li><BedDouble size={12} aria-hidden />{bedsLabel(property.availableSpaces)}</li>
            {property.utilitiesEnabled && <li><Zap size={12} aria-hidden />Utilities billed per room</li>}
          </ul>
          <p className="hostel-detail-note">Prices are for the whole {period.name}, from {new Date(`${period.startsOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} to {new Date(`${period.endsOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.</p>
        </section>
        <section className="hostel-rooms">
          <div className="hostel-results-head">
            <h2>Rooms and beds</h2>
            <span>From {cedis(cheapest)} a year</span>
          </div>
          {[...rooms.entries()].map(([roomLabel, beds]) => <article key={roomLabel} className="hostel-room">
            <header>
              <strong>{roomLabel}</strong>
              <span>{beds.length} of {beds[0]?.capacity || beds.length} beds free in this room</span>
            </header>
            <ul>
              {beds.map((bed) => <li key={bed.spaceId}>
                <div>
                  <strong>{bed.spaceLabel || "Bed"}</strong>
                  <span>One student · room of {bed.capacity}</span>
                </div>
                <div className="hostel-bed-price">
                  <span>{cedis(bed.price)} rent{bed.utilitiesFee > 0 ? ` + ${cedis(bed.utilitiesFee)} utilities` : ""}</span>
                  <strong>{cedis(bed.total)}</strong>
                </div>
                <HostelBookButton listingId={bed.listingId} bedLabel={`${bed.spaceLabel || "bed"} in ${roomLabel}`} />
              </li>)}
            </ul>
          </article>)}
        </section>
        <PropertyReviews propertyId={property.id} />
      </div>
      <aside className="hostel-side">
        <HostelMap properties={[{
          id: property.id,
          name: property.name,
          latitude: property.latitude,
          longitude: property.longitude,
          availableSpaces: property.availableSpaces,
          minTotal: property.minTotal,
          distanceM: property.distanceM,
        }]} title="Where you would live" />
        <PropertyAssistant propertyId={property.id} propertyName={property.name} />
        <section className="hostel-how">
          <p>BEFORE YOU BOOK</p>
          <ul>
            <li><BedDouble size={16} aria-hidden /><span>One booking is one bed. Two beds means two bookings.</span></li>
            <li><Zap size={16} aria-hidden /><span>{property.utilitiesEnabled ? "Utilities are charged per room and already added to the yearly total." : "This landlord does not add a utilities fee."}</span></li>
            <li><MapPin size={16} aria-hidden /><span>{property.latitude !== null && property.longitude !== null ? "The pin is the location the landlord registered with the platform." : "This landlord has not pinned the building yet — call before you travel."}</span></li>
          </ul>
        </section>
      </aside>
    </div>
  </CampusShell>;
}
