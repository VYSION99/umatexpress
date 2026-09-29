"use client";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { HostelStaffGuide } from "@/components/console/hostel/HostelStaffGuide";

export default function HostelStaffGuidePage() {
  return <ConsoleSessionGate label="the Hostel Finder staff guide">
    {session => ["LANDLORD", "ADMIN", "MODERATOR"].includes(session.account.role)
      ? <ConsoleShell session={session} service="hostels" label="ACCOMMODATION · HELP" title="Hostel Finder staff guide" blurb="Role-specific procedures and an assistant grounded in the current Hostel Finder guide.">
          <HostelStaffGuide role={session.account.role}/>
        </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="HOSTEL FINDER HELP" blurb="This guide is for hostel owners, managers, moderators, and administrators."/>}
  </ConsoleSessionGate>;
}
