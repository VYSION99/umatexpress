"use client";

import { CampusAdminDashboard } from "@/components/campusRide/admin/CampusAdminDashboard";
import { CampusFeedbackPanel } from "@/components/campusRide/admin/CampusFeedbackPanel";
import { CampusRefundsPanel } from "@/components/campusRide/admin/CampusRefundsPanel";
import { DriverApplicationsPanel } from "@/components/campusRide/admin/DriverApplicationsPanel";
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
          blurb="Manage zones, corridors, drivers, vehicles, fares, live rides, paid queues, student refunds and ride ratings."
        >
          <div className="console-body campus-admin-shell"><CampusAdminDashboard /></div>
          <div className="console-body campus-admin-shell">
            <DriverApplicationsPanel />
          </div>
          <div className="console-body campus-admin-shell">
            <CampusRefundsPanel />
          </div>
          <div className="console-body campus-admin-shell">
            <CampusFeedbackPanel />
          </div>
        </ConsoleShell>
      : <ConsoleUnavailable session={session} service="campus" label="CAMPUS OPERATIONS" blurb="Campus operations belong to an administrator account." />}
  </ConsoleSessionGate>;
}
