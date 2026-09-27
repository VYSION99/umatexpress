import Link from "next/link";
import { ArrowRight, Bed, Lightning, MapPin } from "@phosphor-icons/react/ssr";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import type { PublicProperty } from "@/lib/hostel-engine/listings";
import { HostelChoiceActions } from "./HostelChoices";
import { Stars } from "@/components/campusRide/hostel/PropertyReviews";

/**
 * The answer under the map: every approved building in the open year, in the
 * order the filters asked for. The card keeps to four facts a student uses to
 * decide whether to open it — where it is, how far, how many beds are free and
 * what the cheapest one costs.
 */
export function HostelPropertyList({ properties, periodId = "", total = properties.length }: { properties: PublicProperty[]; periodId?: string; total?: number }) {
  if (!properties.length) {
    return <section className="hostel-empty">
      <Bed size={26} aria-hidden />
      <h2>No hostel beds match this search</h2>
      <p>Try another academic year, a wider distance or a bigger budget. New beds appear here the moment the platform approves them.</p>
      <Link href={`/hostel?periodId=${encodeURIComponent(periodId)}`} className="hostel-card-link">Clear the filters</Link>
    </section>;
  }
  return <section className="hostel-results" aria-label="Hostels">
    <div className="hostel-results-head">
      <h2>{total} {total === 1 ? "hostel" : "hostels"}</h2>
      <span>Approved beds · selected academic year</span>
    </div>
    <div className="hostel-card-grid">
      {properties.map((property) => <article key={property.id} className="hostel-card">
        {property.coverPhotoId ? <Link href={`/hostel/${encodeURIComponent(property.id)}?periodId=${encodeURIComponent(periodId)}`} className="hostel-card-cover" aria-hidden tabIndex={-1}>
          <img src={`/api/hostel/photos/${property.coverPhotoId}?width=640`} srcSet={[320, 640, 960].map(width => `/api/hostel/photos/${property.coverPhotoId}?width=${width} ${width}w`).join(", ")} sizes="(max-width: 560px) calc(100vw - 64px), (max-width: 980px) 45vw, 340px" width={640} height={360} alt="" loading="lazy" decoding="async" />
        </Link> : <div className="hostel-card-cover hostel-photo-placeholder"><Bed size={30} aria-hidden /><span>Photos coming soon</span></div>}
        <div className="hostel-card-top">
          <h3><Link href={`/hostel/${encodeURIComponent(property.id)}?periodId=${encodeURIComponent(periodId)}`}>{property.name}</Link></h3>
          <span className="hostel-card-beds">{bedsLabel(property.availableSpaces)}</span>
        </div>
        <p className="hostel-card-address"><MapPin size={14} aria-hidden />{property.address || "Address on the property page"}</p>
        {property.ratingCount > 0 && <p className="hostel-card-rating"><Stars rating={property.ratingAverage} size={13} /><span>{property.ratingAverage.toFixed(1)} ({property.ratingCount})</span></p>}
        <ul className="hostel-card-facts">
          <li>{distanceLabel(property.distanceM)}</li>
          <li>{property.roomCount} {property.roomCount === 1 ? "room" : "rooms"}</li>
          {property.utilitiesEnabled && <li><Lightning size={12} aria-hidden />Total includes utilities</li>}
        </ul>
        <HostelChoiceActions propertyId={property.id} propertyName={property.name} />
        <div className="hostel-card-foot">
          <div>
            <span>From</span>
            <strong>{cedis(property.minTotal)}</strong>
            <small>per academic year{property.utilitiesEnabled ? ", including utilities" : ""}</small>
          </div>
          <Link href={`/hostel/${encodeURIComponent(property.id)}?periodId=${encodeURIComponent(periodId)}`} className="hostel-card-link">See the beds <ArrowRight size={14} aria-hidden /></Link>
        </div>
      </article>)}
    </div>
  </section>;
}
