"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { ResidentWorkspace } from "@/components/console/hostel/ResidentWorkspace";

/**
 * The residents side of the hostel workspace: who paid for which bed, what they
 * asked for on top of it, the services switched on for the year, and the
 * managers the owner has trusted. A delegate manager reaches the same page
 * because ownership resolves to the landlord account, not to the email.
 */
export default function HostelResidentsPage() {
  return <ConsoleSessionGate label="the hostel residents">
    {(session) => session.account.role === "LANDLORD"
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION"
        title="Residents & services"
        blurb="Every student who has paid for a bed, what they have asked for since, and the services your hostel offers them."
      >
        <ResidentWorkspace session={session} />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="HOSTEL FINDER" blurb="This workspace belongs to a landlord account." />}
  </ConsoleSessionGate>;
}
