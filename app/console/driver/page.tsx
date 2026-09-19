"use client";

import { DriverOperationsPanel } from "@/components/campusRide/driver/DriverOperationsPanel";
import { CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

export default function ConsoleDriverPage() {
  return <ConsoleSessionGate label="the driver portal">
    {(session) => session.account.role === "DRIVER"
      ? <ConsoleShell
          session={session}
          service="driver"
          label="BOARDING & QUEUES"
          title="Campus driver dashboard"
          blurb="Open a ride, update your location, and board the passengers waiting for you."
        >
          <div className="console-body campus-driver-shell">
            <CampusStatusBanner title="Live driver mode" message="Update your zone, open rides, and board paid passengers from here." />
            <DriverOperationsPanel />
          </div>
        </ConsoleShell>
      : <ConsoleUnavailable session={session} service="driver" label="BOARDING & QUEUES" blurb="The driver portal belongs to a driver account." />}
  </ConsoleSessionGate>;
}
