"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { PlatformSettings } from "@/components/console/PlatformSettings";

/**
 * Platform settings. Admin only: the deployment-wide switches, starting with
 * whether the scheduled payout jobs may move money without an administrator.
 */
export default function ConsoleSettingsPage() {
  return <ConsoleSessionGate label="the platform settings">
    {(session) => session.account.role === "ADMIN"
      ? <ConsoleShell
        session={session}
        service="settings"
        label="PLATFORM · CONTROLS"
        title="Platform settings"
        blurb="The switches that decide how the whole deployment behaves, starting with the automation behind payouts."
      >
        <PlatformSettings />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="settings" label="PLATFORM SETTINGS" blurb="Platform switches belong to an administrator." />}
  </ConsoleSessionGate>;
}
