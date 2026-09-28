"use client";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelOnboarding } from "@/components/console/hostel/HostelOnboarding";
export default function HostelOnboardingPage() {
  return <ConsoleSessionGate label="hostel onboarding">{session => session.account.role === "LANDLORD"
    ? <ConsoleShell session={session} service="hostels" label="HOSTEL FINDER" title="Set up your hostel" blurb="Three steps, each reviewed separately. Save your progress and continue any time."><HostelOnboarding/></ConsoleShell>
    : <ConsoleUnavailable session={session} service="hostels" label="HOSTEL FINDER" blurb="This setup belongs to a landlord account."/>}</ConsoleSessionGate>;
}
