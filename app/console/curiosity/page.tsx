"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { CuriosityShadowPanel } from "@/components/console/CuriosityShadowPanel";

export default function CuriosityConsolePage() {
  return <ConsoleSessionGate label="curiosity policy diagnostics">
    {(session) => session.account.role === "ADMIN" && session.account.delegateServices === undefined
      ? <ConsoleShell session={session} service="settings" label="PLATFORM · DISCOVERY" title="Curiosity policy" blurb="Inspect live readiness and synthetic decisions before inviting students into a pilot."><CuriosityShadowPanel /></ConsoleShell>
      : <ConsoleUnavailable session={session} service="settings" label="CURIOSITY POLICY" blurb="Only the primary administrator can inspect curiosity policy diagnostics." />}
  </ConsoleSessionGate>;
}
