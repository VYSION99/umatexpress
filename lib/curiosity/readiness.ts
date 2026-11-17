import { envValue } from "@/lib/runtime-env";
import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { curiosityCatalog, type CuriosityCapability, type CuriosityServiceId } from "./catalog";
import type { CuriosityReadiness } from "./policy";
import { curiosityPilotConfig } from "./pilot-access";

export async function curiosityPilotEnabled() {
  return (await curiosityPilotConfig()).enabled;
}

async function hasCurrentBrowseableOffer(id: CuriosityServiceId): Promise<boolean> {
  if (id === "hostels") {
    const { listPublicProperties } = await import("@/lib/hostel-engine/listings");
    const result = await listPublicProperties({ pageSize: 1 });
    return result.total > 0;
  }
  if (id === "food") {
    const { listPublicFoodListings } = await import("@/lib/food/listings");
    const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
    return (await listPublicFoodListings()).some((row) => Date.parse(row.verifiedAt) >= cutoff);
  }
  if (id === "print-copy") {
    const { listPublicPrintCopyProviders } = await import("@/lib/print-copy/directory");
    return (await listPublicPrintCopyProviders()).length > 0;
  }
  // These live services offer browsing or room creation without a current
  // booking claim. Suggestions never say that capacity or events are available.
  return true;
}

/** Fail closed on missing data and checks; expose no provider or student records. */
export async function curiosityReadiness(capabilities: CuriosityCapability[] = curiosityCatalog()): Promise<CuriosityReadiness[]> {
  const configured = await isTursoConfiguredRuntime();
  let reachable = false;
  if (configured) { try { await turso("SELECT 1"); reachable = true; } catch { /* Fail closed when the data source is unavailable. */ } }
  const excluded = new Set((await envValue("CURIOSITY_EXCLUDED_SERVICES")).split(",").map((id) => id.trim()).filter(Boolean));
  const checkedAt = new Date().toISOString();
  return Promise.all(capabilities.map(async ({ id, launched }) => {
    if (!launched) return { serviceId: id, eligible: false, reasonCode: "NOT_LAUNCHED", checkedAt };
    if (excluded.has(id)) return { serviceId: id, eligible: false, reasonCode: "SERVICE_EXCLUDED", checkedAt };
    if (!reachable) return { serviceId: id, eligible: false, reasonCode: "DATA_UNAVAILABLE", checkedAt };
    try {
      const eligible = await hasCurrentBrowseableOffer(id);
      return { serviceId: id, eligible, reasonCode: eligible ? "READY" : "NO_VERIFIED_OFFER", checkedAt };
    } catch {
      return { serviceId: id, eligible: false, reasonCode: "READINESS_CHECK_FAILED", checkedAt };
    }
  }));
}
