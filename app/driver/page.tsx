import { DriverOperationsPanel } from "@/components/campusRide/driver/DriverOperationsPanel";
import { CampusShell, CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";

export default function DriverPage() {
  return <CampusShell area="DRIVER PORTAL" title="Campus driver dashboard" subtitle="Open rides, update location, and manage paid queue passengers.">
    <CampusStatusBanner title="Live driver mode" message="Drivers can sign in, update current zone, open rides, pause/resume, and end rides." />
    <DriverOperationsPanel />
  </CampusShell>;
}
