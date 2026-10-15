/**
 * Public Food directory data.
 *
 * Only entries that have been reviewed with their provider belong here. Keep
 * this list empty until provider identity, listing details, and the correction
 * contact have been confirmed. This first slice is read-only: it does not take
 * orders or payments.
 */
export type FoodListing = {
  id: string;
  name: string;
  description: string;
  location: string;
  contactLabel: string;
  contactHref: string;
  hours: string;
  menuItems: Array<{
    name: string;
    description: string;
    priceGhs: number;
    dietaryNote: string;
    updatedAt: string;
  }>;
  updatedAt: string;
  verifiedAt: string;
};

const reviewedListings: readonly FoodListing[] = [];

function isPublicContact(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("tel:");
}

/** Public listings are reviewed before display; unpublished entries never ship. */
export function listPublicFoodListings(): FoodListing[] {
  return reviewedListings
    .filter((listing) => listing.id && listing.name && listing.verifiedAt && listing.updatedAt && isPublicContact(listing.contactHref))
    .map((listing) => ({ ...listing }));
}
