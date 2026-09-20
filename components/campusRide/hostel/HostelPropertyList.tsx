import Link from "next/link";
import { ArrowRight, BedDouble, MapPin, Zap } from "lucide-react";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import type { PublicProperty } from "@/lib/hostel-engine/listings";

/**
 * The answer under the map: every approved building in the open year, in the
 * order the filters asked for. The card keeps to four facts a student uses to
 * decide whether to open it — where it is, how far, how many beds are free and
 * what the cheapest one costs.
 */
export function HostelPropertyList({ properties }: { properties: PublicProperty[] }) {
  if (!properties.length) {
    return <section className="hostel-empty">
      <BedDouble size={26} aria-hidden />
      <h2>No hostel beds match this search</h2>
      <p>Try another academic year, a wider distance or a bigger budget. New beds appear here the moment the platform approves them.</p>
      <Link href="/hostel" className="hostel-card-link">Clear the filters</Link>
    </section>;
  }
  return <section className="hostel-results" aria-label="Hostels">
    <div className="hostel-results-head">
      <h2>{properties.length} {properties.length === 1 ? "hostel" : "hostels"}</h2>
      <span>Approved for the open academic year</span>
    </div>
    <div className="hostel-card-grid">
      {properties.map((property) => <article key={property.id} className="hostel-card">
        <div className="hostel-card-top">
          <h3><Link href={`/hostel/${encodeURIComponent(property.id)}`}>{property.name}</Link></h3>
          <span className="hostel-card-beds">{bedsLabel(property.availableSpaces)}</span>
        </div>
        <p className="hostel-card-address"><MapPin size={14} aria-hidden />{property.address || "Address on the property page"}</p>
        <ul className="hostel-card-facts">
          <li>{distanceLabel(property.distanceM)}</li>
          <li>{property.roomCount} {property.roomCount === 1 ? "room" : "rooms"}</li>
          {property.utilitiesEnabled && <li><Zap size={12} aria-hidden />Utilities included</li>}
        </ul>
        <div className="hostel-card-foot">
          <div>
            <span>From</span>
            <strong>{cedis(property.minTotal)}</strong>
            <small>a year{property.utilitiesEnabled ? ", utilities included" : ""}</small>
          </div>
          <Link href={`/hostel/${encodeURIComponent(property.id)}`} className="hostel-card-link">See the beds <ArrowRight size={14} aria-hidden /></Link>
        </div>
      </article>)}
    </div>
  </section>;
}
