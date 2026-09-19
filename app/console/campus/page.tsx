"use client";

import { CampusAdminDashboard } from "@/components/campusRide/admin/CampusAdminDashboard";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

export default function ConsoleCampusPage() {
  return <ConsoleSessionGate label="CampusRide operations">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
          session={session}
          service="campus"
          label="CAMPUS OPERATIONS"
          title="CampusRide control center"
          blurb="Manage zones, corridors, drivers, vehicles, fares, live rides and paid queues."
        >
          <div className="console-body campus-admin-shell"><CampusAdminDashboard /></div>
        </ConsoleShell>
      : <ConsoleUnavailable session={session} service="campus" label="CAMPUS OPERATIONS" blurb="Campus operations belong to an administrator account." />}
  </ConsoleSessionGate>;
}
