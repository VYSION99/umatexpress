import type { Metadata } from "next";
import { BedDouble, KeyRound, MapPinned } from "lucide-react";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { HostelFilters } from "@/components/campusRide/hostel/HostelFilters";
import { HostelMap } from "@/components/campusRide/hostel/HostelMap";
import { HostelPropertyList } from "@/components/campusRide/hostel/HostelPropertyList";
import { listPublicProperties } from "@/lib/hostel-engine/listings";
import { defaultHostelPeriodId, listHostelPeriods } from "@/lib/hostel-engine/periods";

export const metadata: Metadata = {
  title: "Hostel Finder | UMaTeXPRESS",
  description: "Browse approved student hostels around UMaT: beds, yearly prices, utilities and how far each building is from campus.",
};

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || "";
const bounded = (value: string, max: number) => {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? String(Math.round(parsed)) : "";
};

/**
 * The student front door to Hostel Finder: open to anyone, no account needed.
 * Every filter lives in the URL, so a search can be shared, and the page renders
 * the same result the API would return because both call the same public gate.
 */
export default async function HostelPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = (await searchParams) || {};
  const periods = await listHostelPeriods();
  const requestedPeriod = first(params.periodId);
  const periodId = periods.some((period) => period.id === requestedPeriod) ? requestedPeriod : defaultHostelPeriodId(periods);
  const sortParam = first(params.sort);
  const sort: "distance" | "price" | "name" = sortParam === "distance" || sortParam === "price" ? sortParam : "name";
  const filters = {
    maxDistance: bounded(first(params.maxDistance), 50_000),
    maxPrice: bounded(first(params.maxPrice), 50_000_000),
    minSpaces: bounded(first(params.minSpaces), 60),
    utilities: first(params.utilities) === "1",
    sort,
  };
  const { period, properties } = await listPublicProperties({
    periodId,
    maxDistanceM: filters.maxDistance === "" ? undefined : Number(filters.maxDistance),
    maxPrice: filters.maxPrice === "" ? undefined : Number(filters.maxPrice),
    minSpaces: filters.minSpaces === "" ? undefined : Number(filters.minSpaces),
    utilitiesOnly: filters.utilities,
    sort,
  });

  return <CampusShell area="HOSTELFINDER" title="Find your own corner of campus" subtitle="Approved hostel beds around UMaT, with the yearly price and the walk to campus in plain sight.">
    {period ? <>
      <section className="campus-status-banner">
        <strong>{period.name}</strong>
        <span>Every bed below is approved by the platform. Browsing is open to everyone.</span>
      </section>
      <div className="hostel-layout">
        <div className="hostel-main">
          <HostelFilters
            periods={periods.map((item) => ({ id: item.id, name: item.name }))}
            value={{ periodId: period.id, ...filters }}
            matchCount={properties.length}
          />
          <HostelPropertyList properties={properties} />
        </div>
        <aside className="hostel-side">
          <HostelMap properties={properties.map((property) => ({
            id: property.id,
            name: property.name,
            latitude: property.latitude,
            longitude: property.longitude,
            availableSpaces: property.availableSpaces,
            minTotal: property.minTotal,
            distanceM: property.distanceM,
          }))} />
          <section className="hostel-how">
            <p>HOW IT WORKS</p>
            <ul>
              <li><MapPinned size={16} aria-hidden /><span><strong>Find a home.</strong> Browse every approved hostel and open the one that fits.</span></li>
              <li><BedDouble size={16} aria-hidden /><span><strong>Pick a bed.</strong> Rooms hold up to six beds, each priced for the academic year.</span></li>
              <li><KeyRound size={16} aria-hidden /><span><strong>Sign in to book.</strong> Booking opens with the next release and uses your @st.umat.edu.gh email.</span></li>
            </ul>
          </section>
        </aside>
      </div>
    </> : <section className="hostel-empty">
      <BedDouble size={26} aria-hidden />
      <h2>The next academic year is not open yet</h2>
      <p>Landlords list their beds a term before students move in. Check back here, or sign in later with your @st.umat.edu.gh email.</p>
    </section>}
  </CampusShell>;
}
