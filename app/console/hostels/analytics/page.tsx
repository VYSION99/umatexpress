"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelAnalytics } from "@/components/console/hostel/HostelAnalytics";

/**
 * The platform's hostel scoreboard: occupancy, bookings, money and trust.
 * Admin only.
 */
export default function HostelAnalyticsPage() {
  return <ConsoleSessionGate label="hostel analytics">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION · ANALYTICS"
        title="Hostel analytics"
        blurb="Occupancy, the booking pipeline, what the year has collected and what trust looks like across the buildings."
      >
        <HostelAnalytics />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="HOSTEL ANALYTICS" blurb="Platform metrics belong to an administrator." />}
  </ConsoleSessionGate>;
}
