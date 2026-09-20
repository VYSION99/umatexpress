import Link from "next/link";
import { BedDouble } from "lucide-react";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";

export default function HostelNotFound() {
  return <CampusShell area="HOSTELFINDER" title="That hostel is not on the map" subtitle="It may have been suspended, taken down, or not approved yet.">
    <section className="hostel-empty">
      <BedDouble size={26} aria-hidden />
      <h2>Nothing to show here</h2>
      <p>Only approved hostels appear in Hostel Finder. Browse everything that is live right now.</p>
      <Link href="/hostel" className="hostel-card-link">Back to Hostel Finder</Link>
    </section>
  </CampusShell>;
}
