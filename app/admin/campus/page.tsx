import { AdminGate } from "@/components/admin/AdminGate";
import { CampusAdminDashboard } from "@/components/campusRide/admin/CampusAdminDashboard";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";

export default function AdminCampusPage() {
  return <AdminGate label="campusRide admin"><CampusShell area="ADMIN · CAMPUSRIDE" title="CampusRide control center" subtitle="Manage zones, drivers, vehicles, fares, live rides, and queues.">
    <CampusAdminDashboard />
  </CampusShell></AdminGate>;
}
