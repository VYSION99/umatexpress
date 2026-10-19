import type { Metadata } from "next";
import Link from "next/link";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { MapPin, ShieldCheck } from "@/components/ui/MaterialIcon";
import { listPublicFoodListings } from "@/lib/food/listings";
import { FoodReportButton } from "@/components/food/FoodReportButton";
import { FoodPreorderButton } from "@/components/food/FoodPreorderButton";
import "./food.css";

export const metadata: Metadata = {
  title: "Food | UMaTeXPRESS",
  description: "A campus food directory with provider-verified details.",
};

function updatedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Update time unavailable" : `Details updated ${new Intl.DateTimeFormat("en-GH", { dateStyle: "medium" }).format(date)}`;
}

function priceLabel(value: number): string {
  return new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS", maximumFractionDigits: 2 }).format(value);
}

export default async function FoodPage() {
  const listings = await listPublicFoodListings().catch(() => []);

  return <CampusShell
    area="FOOD"
    title="Find food around campus"
    subtitle="Browse provider-verified food places. This directory does not take orders or payments."
  >
    <div className="food-directory">
      <section className="food-trust-note" aria-label="How Food listings are reviewed">
        <ShieldCheck size={20} aria-hidden />
        <p><strong>Provider-checked details</strong><span>Hours, location, and menu information will show when a provider has confirmed them.</span></p>
      </section>

      {listings.length ? <section className="food-listings" aria-label="Verified food providers">
        {listings.map((listing, listingIndex) => <article className="food-listing" key={listing.id}>
          <div className="food-listing-heading">
            <div><h2>{listing.name}</h2><p>{listing.description}</p></div>
            <span className="food-verified"><ShieldCheck size={15} aria-hidden /> Verified</span>
          </div>
          <p className="food-location"><MapPin size={16} aria-hidden />{listing.location}</p>
          <dl className="food-details">
            <div><dt>Hours</dt><dd>{listing.hours}</dd></div>
            <div><dt>Provider checked</dt><dd>{updatedLabel(listing.verifiedAt)}</dd></div>
            <div><dt>Menu updated</dt><dd>{updatedLabel(listing.updatedAt)}</dd></div>
            {listing.pickupDetails && <div><dt>Pickup</dt><dd>{listing.pickupDetails}</dd></div>}
          </dl>
          {listing.menuItems.length > 0 && <section className="food-menu" aria-label={`${listing.name} menu`}>
            <h3>Menu</h3>
            <ul>{listing.menuItems.map((item, index) => <li key={`${listing.id}-${index}`}>
              <div><strong>{item.name}</strong>{item.description && <p>{item.description}</p>}{item.dietaryNote && <small>{item.dietaryNote}</small>}</div>
              <span>{priceLabel(item.priceGhs)}</span>
            </li>)}</ul>
            <p className="food-menu-note">Menu and dietary details are supplied by the provider. Confirm ingredients and availability with them before ordering.</p>
          </section>}
          <a className="food-contact" href={listing.contactHref}>{listing.contactLabel}</a>
          <FoodPreorderButton listing={listing} showOrders={listingIndex === 0} />
          <FoodReportButton providerId={listing.id} providerName={listing.name} />
        </article>)}
      </section> : <section className="food-empty" aria-labelledby="food-empty-title">
        <span className="food-empty-icon"><MapPin size={24} aria-hidden /></span>
        <h2 id="food-empty-title">No verified food listings yet</h2>
        <p>We’re confirming provider details before publishing them. You can still use the usual campus contacts and food places you already know.</p>
        <Link href="/" className="food-home-link">Back to services</Link>
      </section>}
    </div>
  </CampusShell>;
}
