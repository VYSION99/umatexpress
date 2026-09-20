"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { PluginCatalogue } from "@/components/console/hostel/PluginCatalogue";

/**
 * The platform's hostel service catalogue. Admin only: one price list for every
 * landlord, and the resident default each of them starts from.
 */
export default function HostelPluginsPage() {
  return <ConsoleSessionGate label="the hostel service catalogue">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION · CATALOGUE"
        title="Service catalogue"
        blurb="The services a landlord may add for residents, what the platform charges for each, and the resident price a landlord starts from."
      >
        <PluginCatalogue />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="SERVICE CATALOGUE" blurb="The catalogue belongs to an administrator." />}
  </ConsoleSessionGate>;
}
