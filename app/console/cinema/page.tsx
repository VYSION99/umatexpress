"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { CinemaRoomsPanel } from "@/components/console/cinema/CinemaRoomsPanel";
import { CinemaOrganizerRequests } from "@/components/console/cinema/CinemaOrganizerRequests";
import { CinemaRoomPlans } from "@/components/console/cinema/CinemaRoomPlans";
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
        title="OnlineCinema"
        blurb="Manage active and recently ended watch rooms, hosts and participants."
      >
        <CinemaRoomsPanel />
        {session.account.role === "ADMIN" && <CinemaOrganizerRequests />}
        {session.account.role === "ADMIN" && <CinemaRoomPlans />}
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="cinema" label="STUDY ROOMS" blurb="Watch room management requires platform staff access." />}
  </ConsoleSessionGate>;
}
