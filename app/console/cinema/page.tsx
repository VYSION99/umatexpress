"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { CinemaRoomsPanel } from "@/components/console/cinema/CinemaRoomsPanel";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

/**
 * Every Cinema room on the platform. Staff only: the student lobby shows the
 * rooms one student is in, and this shows the ones they are not.
 */
export default function CinemaRoomsPage() {
  return <ConsoleSessionGate label="study rooms">
    {(session) => session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ConsoleShell
        session={session}
        service="cinema"
        label="ENTERTAINMENT · WATCH"
        title="Study rooms"
        blurb="Every collaborative watch room, live or recently ended, with the host and the people in it."
      >
        <CinemaRoomsPanel />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="cinema" label="STUDY ROOMS" blurb="Watch rooms belong to platform staff." />}
  </ConsoleSessionGate>;
}
