"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { FoodDirectoryManager } from "@/components/console/food/FoodDirectoryManager";
import { FoodVendorOrders } from "@/components/console/food/FoodVendorOrders";
import { FoodVendorOperations } from "@/components/console/food/FoodVendorOperations";
import { FoodPilotManager } from "@/components/console/food/FoodPilotManager";

export default function FoodConsolePage() {
  return <ConsoleSessionGate label="Food directory">
    {(session) => session.account.role === "VENDOR"
      ? <ConsoleShell session={session} service="food" label="FOOD VENDOR · OPERATIONS" title="Food operations" blurb="Keep availability truthful, accept only what you can prepare, and record every handover accurately."><FoodVendorOperations /><FoodVendorOrders /></ConsoleShell>
      : session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ConsoleShell session={session} service="food" label="CAMPUS FOOD · CONTROLLED PILOT" title="Food operations" blurb="Verify providers, control the pilot, monitor fulfilment, and resolve student cases."><FoodDirectoryManager /><FoodPilotManager /></ConsoleShell>
      : <ConsoleUnavailable session={session} service="food" label="FOOD DIRECTORY" blurb="Food listing management belongs to platform staff." />}
  </ConsoleSessionGate>;
}
