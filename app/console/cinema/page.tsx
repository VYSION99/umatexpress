"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { CinemaRoomsPanel } from "@/components/console/cinema/CinemaRoomsPanel";
import { CinemaOrganizerRequests } from "@/components/console/cinema/CinemaOrganizerRequests";
import { CinemaPartnerRequests } from "@/components/console/cinema/CinemaPartnerRequests";
import { CinemaPartnerWorkspace } from "@/components/console/cinema/CinemaPartnerWorkspace";
import { CinemaRoomPlans } from "@/components/console/cinema/CinemaRoomPlans";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

/**
 * Every Cinema room on the platform. Staff oversee rooms and partner applications;
 * verified cinema partners manage their venue screenings.
 */
export default function CinemaRoomsPage() {
  return <ConsoleSessionGate label="cinema">
    {(session) => {
      const isStaff = session.account.role === "ADMIN" || session.account.role === "MODERATOR";
      const isPartner = session.account.role === "CINEMA";

      if (isPartner) {
        return <ConsoleShell
          session={session}
          service="cinema"
          label="ENTERTAINMENT · PARTNER"
          title="OnlineCinema Partner"
          blurb="Manage your screening venue, published showings and watch parties."
        >
          <CinemaPartnerWorkspace />
        </ConsoleShell>;
      }

      if (isStaff) {
        return <ConsoleShell
          session={session}
          service="cinema"
          label="ENTERTAINMENT · WATCH"
          title="OnlineCinema"
          blurb="Manage active and recently ended watch rooms, hosts and participants."
        >
          <CinemaRoomsPanel />
          {session.account.role === "ADMIN" && <CinemaPartnerRequests />}
          {session.account.role === "ADMIN" && <CinemaOrganizerRequests />}
          {session.account.role === "ADMIN" && <CinemaRoomPlans />}
        </ConsoleShell>;
      }

      return <ConsoleUnavailable session={session} service="cinema" label="ONLINE CINEMA" blurb="OnlineCinema management requires partner or platform staff access." />;
    }}
  </ConsoleSessionGate>;
}
