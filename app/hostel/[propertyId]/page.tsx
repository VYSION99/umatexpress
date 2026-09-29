import "@/components/campusRide/hostel/hostel.css";
import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Bed, Door, Lightning, MapPin } from "@phosphor-icons/react/ssr";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { HostelChoiceActions, HostelChoicesPanel, HostelChoicesProvider } from "@/components/campusRide/hostel/HostelChoices";
import { HostelBedPicker } from "@/components/campusRide/hostel/HostelBedPicker";
import { HostelViewingRequest } from "@/components/campusRide/hostel/HostelViewingRequest";
import { HostelWalkingRoutes } from "@/components/campusRide/hostel/HostelWalkingRoutes";
import { listWalkingDestinations } from "@/lib/hostel-engine/walking";
import { HostelVerificationCard } from "@/components/campusRide/hostel/HostelVerificationCard";
import { listPublicHostelVerifications } from "@/lib/hostel-engine/verification";
import { HostelRoomMedia } from "@/components/campusRide/hostel/HostelRoomMedia";
import { HostelGallery } from "@/components/campusRide/hostel/HostelGallery";
import { DeferredHostelMap } from "@/components/campusRide/hostel/DeferredHostelMap";
import { PropertyAssistant } from "@/components/campusRide/hostel/PropertyAssistant";
import { PropertyReviews } from "@/components/campusRide/hostel/PropertyReviews";
import { bedsLabel, distanceLabel } from "@/components/campusRide/hostel/format";
import { getPublicProperty } from "@/lib/hostel-engine/listings";
import { defaultHostelPeriodId, listHostelPeriods } from "@/lib/hostel-engine/periods";

type PageProps = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const loadProperty = cache(async (propertyId: string, requestedPeriod?: string) => {
  const periods = await listHostelPeriods();
  const periodId = periods.some(item => item.id === requestedPeriod) ? requestedPeriod : defaultHostelPeriodId(periods);
  return getPublicProperty(propertyId, periodId);
});

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { propertyId } = await params;
  const query = (await searchParams) || {};
  const requested = Array.isArray(query.periodId) ? query.periodId[0] : query.periodId;
  const record = await loadProperty(propertyId, requested);
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
  const record = await loadProperty(propertyId, requestedPeriod);
  if (!record) notFound();
  const { period, property, spaces, photos, reviews } = record;
  const [verifications, destinations] = await Promise.all([listPublicHostelVerifications(property.id), listWalkingDestinations()]);

  return <CampusShell area="HOSTELFINDER" title={property.name} subtitle={`${period.name} · ${bedsLabel(property.availableSpaces)}`}>
    <nav className="hostel-breadcrumb">
      <Link href="/hostel/help">Hostel Finder help</Link>
      <Link href={`/hostel?periodId=${encodeURIComponent(period.id)}`}><ArrowLeft size={14} aria-hidden /> All hostels</Link>
    </nav>
    <HostelChoicesProvider periodId={period.id}><HostelChoicesPanel /><HostelChoiceActions propertyId={property.id} propertyName={property.name} /></HostelChoicesProvider>
    <div className="hostel-layout">
      <div className="hostel-main">
        <HostelGallery photos={photos.filter(photo => (photo.scopeType === "PROPERTY" || photo.scopeType === "BUILDING_AREA") && photo.mediaKind === "PHOTO")} name={property.name} />
        <section className="hostel-detail-card">
          <p>ABOUT THIS HOSTEL</p>
          <h2>{property.address || "Address shared on request"}</h2>
          <ul className="hostel-card-facts">
            <li><MapPin size={12} aria-hidden />{distanceLabel(property.distanceM)}</li>
            <li><Door size={12} aria-hidden />{property.roomCount} {property.roomCount === 1 ? "room" : "rooms"}</li>
            <li><Bed size={12} aria-hidden />{bedsLabel(property.availableSpaces)}</li>
            {property.utilitiesEnabled && <li><Lightning size={12} aria-hidden />Total includes utilities</li>}
          </ul>
          <p className="hostel-detail-note">Prices are for the whole {period.name}, from {new Date(`${period.startsOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} to {new Date(`${period.endsOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.</p>
        </section>
        {!property.bookingReady && <div className="hostel-booking-pause-notice" role="status"><strong>Booking temporarily paused</strong><span>You can browse rooms and request a viewing while this hostel’s payout details are reviewed.</span></div>}
        <HostelRoomMedia photos={photos} spaces={spaces} />
        <HostelViewingRequest propertyId={property.id} />
        <HostelBedPicker spaces={spaces} periodName={period.name} bookingReady={property.bookingReady} />
        <PropertyReviews key={property.id} propertyId={property.id} initial={{ reviews: reviews.map(({ id, rating, title, body, studentName, createdAt, reply, repliedAt }) => ({ id, rating, title, body, studentName, createdAt, reply, repliedAt })), summary: { average: property.ratingAverage, count: property.ratingCount } }} />
      </div>
      <aside className="hostel-side">
        <DeferredHostelMap periodId={period.id} properties={[{
          id: property.id,
          name: property.name,
          latitude: property.latitude,
          longitude: property.longitude,
          availableSpaces: property.availableSpaces,
          minTotal: property.minTotal,
          distanceM: property.distanceM,
        }]} title="Where you would live" />
        <HostelVerificationCard checks={verifications} />
        <HostelWalkingRoutes propertyId={property.id} directDistanceM={property.distanceM} destinations={destinations} />
        <PropertyAssistant propertyId={property.id} propertyName={property.name} />
        <p className="hostel-detail-note">Distances are approximate: supplied by the hostel or measured in a straight line from the campus reference point. They are not walking routes.</p>
        <section className="hostel-how">
          <p>BEFORE YOU BOOK</p>
          <ul>
            <li><Bed size={16} aria-hidden /><span>One booking is one bed. Two beds means two bookings.</span></li>
            <li><Lightning size={16} aria-hidden /><span>{property.utilitiesEnabled ? "Each bed’s displayed total includes the utilities fee shown in its price breakdown." : "No utilities fee is collected with this booking. Confirm any separate charges with the hostel."}</span></li>
            <li><MapPin size={16} aria-hidden /><span>{property.latitude !== null && property.longitude !== null ? "The pin is the location the landlord registered with the platform." : "This landlord has not pinned the building yet — call before you travel."}</span></li>
          </ul>
        </section>
      </aside>
    </div>
  </CampusShell>;
}
