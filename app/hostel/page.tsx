import "@/components/campusRide/hostel/hostel.css";
import Link from "next/link";
import type { Metadata } from "next";
import { Bed, Key, MapPinLine } from "@phosphor-icons/react/ssr";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { HostelFilters } from "@/components/campusRide/hostel/HostelFilters";
import { HostelBrowseView } from "@/components/campusRide/hostel/HostelBrowseView";
import { HostelPropertyList } from "@/components/campusRide/hostel/HostelPropertyList";
import { listPublicProperties } from "@/lib/hostel-engine/listings";
import { defaultHostelPeriodId, listHostelPeriods } from "@/lib/hostel-engine/periods";

export const metadata: Metadata = {
  title: "Hostel Finder | UMaTeXPRESS",
  description: "Browse approved student hostels around UMaT, with clear bed availability, yearly prices, utilities and distance to campus.",
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
    q: first(params.q).trim().slice(0, 100),
    maxDistance: bounded(first(params.maxDistance), 50_000),
    maxPrice: bounded(first(params.maxPrice), 50_000_000),
    minSpaces: bounded(first(params.minSpaces), 60),
    utilities: first(params.utilities) === "1",
    sort,
  };
  const { period, properties, mapProperties, total, page, pageCount } = await listPublicProperties({
    periodId,
    q: filters.q,
    page: Number(bounded(first(params.page), 100000)) || 1,
    maxDistanceM: filters.maxDistance === "" ? undefined : Number(filters.maxDistance),
    maxPrice: filters.maxPrice === "" ? undefined : Number(filters.maxPrice),
    minSpaces: filters.minSpaces === "" ? undefined : Number(filters.minSpaces),
    utilitiesOnly: filters.utilities,
    sort,
  });

  const pageHref = (number: number) => {
    const next = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => { if (first(value)) next.set(key, first(value)); });
    next.set("page", String(number));
    if (period) next.set("periodId", period.id);
    return `/hostel?${next}`;
  };
  return <CampusShell area="HOSTELFINDER" title="Find your own corner of campus" subtitle="Explore approved hostels around UMaT. Compare locations and see bed prices when rooms are ready.">
    {period ? <>
      <section className="campus-status-banner">
        <strong>{period.name}</strong>
        <span>Buildings and photos are staff approved. Bed prices appear only after separate listing review.</span>
      </section>
      <div className="hostel-layout hostel-browse-layout">
        <div className="hostel-main">
          <HostelFilters
            periods={periods.map((item) => ({ id: item.id, name: item.name }))}
            value={{ periodId: period.id, ...filters }}
            matchCount={total}
          />
          <HostelBrowseView periodId={period.id} properties={mapProperties.map(property => ({ id: property.id, name: property.name, latitude: property.latitude, longitude: property.longitude, availableSpaces: property.availableSpaces, minTotal: property.minTotal, distanceM: property.distanceM }))}>
            <HostelPropertyList properties={properties} periodId={period.id} total={total} />
            {pageCount > 1 && <nav className="hostel-pagination" aria-label="Hostel result pages">
              {page > 1 && <Link href={pageHref(page - 1)} scroll={false}>Previous</Link>}
              <span>Page {page} of {pageCount}</span>
              {page < pageCount && <Link href={pageHref(page + 1)} scroll={false}>Next</Link>}
            </nav>}
          </HostelBrowseView>
        </div>
        <aside className="hostel-side">
          <section className="hostel-how">
            <p>HOW IT WORKS</p><Link href="/hostel/help" className="hostel-card-link">Student guide and help assistant →</Link>
            <ul>
              <li><MapPinLine size={16} aria-hidden /><span><strong>Find a home.</strong> Browse approved properties and open the one that fits.</span></li>
              <li><Bed size={16} aria-hidden /><span><strong>Pick a bed.</strong> Rooms hold up to six beds, each priced for the academic year.</span></li>
              <li><Key size={16} aria-hidden /><span><strong>Sign in to book.</strong> Use your @st.umat.edu.gh email, then hold a bed for ten minutes while you pay.</span></li>
            </ul>
          </section>
        </aside>
      </div>
    </> : <section className="hostel-empty">
      <Bed size={26} aria-hidden />
      <h2>The next academic year is not open yet</h2>
      <p>Landlords list their beds a term before students move in. Check back here, or sign in later with your @st.umat.edu.gh email.</p>
    </section>}
  </CampusShell>;
}
