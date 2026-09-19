"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { VacationAdminConsole } from "@/components/admin/VacationAdminConsole";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

export default function ConsoleVacationPage() {
  return <ConsoleSessionGate label="VacationRide operations">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
          session={session}
          service="vacation"
          label="TRIPS & PASSENGERS"
          title="Booking overview"
          blurb="Schedule the coaches, set what the booking page shows, and answer for every passenger on the list."
        >
          <VacationAdminConsole />
        </ConsoleShell>
      : <ConsoleUnavailable session={session} service="vacation" label="TRIPS & PASSENGERS" blurb="Schedules and passenger records belong to an administrator account." />}
  </ConsoleSessionGate>;
}
