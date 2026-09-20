"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { RiskSignalsPanel } from "@/components/console/hostel/RiskSignalsPanel";

/**
 * Trust signals for hostel supply. Staff only: the rules raise what looks
 * wrong, and a person records what it turned out to be.
 */
export default function HostelSignalsPage() {
  return <ConsoleSessionGate label="hostel trust signals">
    {(session) => session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION · TRUST"
        title="Supply signals"
        blurb="What the rules noticed about listings, photos, message threads and payout accounts, and what a person decided."
      >
        <RiskSignalsPanel />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="SUPPLY SIGNALS" blurb="Trust signals belong to platform staff." />}
  </ConsoleSessionGate>;
}
