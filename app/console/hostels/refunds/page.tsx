"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelRefundsPanel } from "@/components/console/hostel/HostelRefundsPanel";

/**
 * The refund desk. Money leaving the platform is an administrator's decision,
 * so this page refuses every other role.
 */
export default function HostelRefundsPage() {
  return <ConsoleSessionGate label="hostel refunds">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION · REFUNDS"
        title="Refund queue"
        blurb="Cancellations students asked for, priced by the policy, waiting for a decision and a transfer."
      >
        <HostelRefundsPanel />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="REFUND QUEUE" blurb="Refunds belong to an administrator." />}
  </ConsoleSessionGate>;
}
