"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { CinemaSignalsPanel } from "@/components/console/cinema/CinemaSignalsPanel";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

/**
 * What students reported about a watch room or a message in it. Staff only:
 * the report is made from inside the room, and the decision belongs here.
 */
export default function CinemaSignalsPage() {
  return <ConsoleSessionGate label="watch reports">
    {(session) => session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ConsoleShell
        session={session}
        service="cinema"
        label="ENTERTAINMENT · TRUST"
        title="Watch reports"
        blurb="Rooms and messages students reported, folded per room or message, with the evidence attached."
      >
        <CinemaSignalsPanel />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="cinema" label="WATCH REPORTS" blurb="Reports belong to platform staff." />}
  </ConsoleSessionGate>;
}
