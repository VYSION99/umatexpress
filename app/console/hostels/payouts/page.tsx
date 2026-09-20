"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelPayoutDesk } from "@/components/console/hostel/HostelPayoutDesk";

/**
 * The hostel payout desk. Admin only: it shows what every landlord has earned,
 * which part may be released, and records the transfer an administrator made.
 */
export default function HostelPayoutsPage() {
  return <ConsoleSessionGate label="the hostel payouts">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION · MONEY OUT"
        title="Hostel payouts"
        blurb="What each landlord earned from paid beds, the 3% the platform keeps, and the transfers behind every release."
      >
        <HostelPayoutDesk />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="HOSTEL PAYOUTS" blurb="Recording a payout belongs to an administrator." />}
  </ConsoleSessionGate>;
}
