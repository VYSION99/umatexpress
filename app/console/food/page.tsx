"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { FoodDirectoryManager } from "@/components/console/food/FoodDirectoryManager";
import { FoodVendorOrders } from "@/components/console/food/FoodVendorOrders";

export default function FoodConsolePage() {
  return <ConsoleSessionGate label="Food directory">
    {(session) => session.account.role === "VENDOR"
      ? <ConsoleShell session={session} service="food" label="FOOD VENDOR · PICKUP" title="Pickup requests" blurb="Accept only the requests you can prepare, keep students updated, and mark each handover accurately."><FoodVendorOrders /></ConsoleShell>
      : session.account.role === "ADMIN" || session.account.role === "MODERATOR"
      ? <ConsoleShell session={session} service="food" label="CAMPUS FOOD · DIRECTORY" title="Food directory" blurb="Prepare provider details, publish only after checking them, and resolve corrections from students."><FoodDirectoryManager /></ConsoleShell>
      : <ConsoleUnavailable session={session} service="food" label="FOOD DIRECTORY" blurb="Food listing management belongs to platform staff." />}
  </ConsoleSessionGate>;
}
