import { envValue } from "@/lib/runtime-env";
import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { curiosityCatalog, type CuriosityCapability, type CuriosityServiceId } from "./catalog";
import type { CuriosityReadiness } from "./policy";
import { curiosityPilotConfig } from "./pilot-access";

export const CURIOSITY_READINESS_TTL_MS = 15_000;
export const CURIOSITY_ADAPTER_TIMEOUT_MS = 1_500;

const readinessCache = new Map<string, { expiresAt: number; result: CuriosityReadiness }>();

export function clearCuriosityReadinessCache() {
  readinessCache.clear();
}

export async function curiosityPilotEnabled() {
  return (await curiosityPilotConfig()).enabled;
}

function withAdapterTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Readiness adapter timed out.")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
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

export type CuriosityReadinessOptions = {
  timeoutMs?: number;
  bypassCache?: boolean;
  ttlMs?: number;
  adapterOverrides?: Partial<Record<CuriosityServiceId, () => Promise<boolean>>>;
};

/** Fail closed on missing data and checks; expose no provider or student records. */
export async function curiosityReadiness(
  capabilities: CuriosityCapability[] = curiosityCatalog(),
  options: CuriosityReadinessOptions = {},
): Promise<CuriosityReadiness[]> {
  const timeoutMs = options.timeoutMs ?? CURIOSITY_ADAPTER_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? CURIOSITY_READINESS_TTL_MS;
  const bypassCache = options.bypassCache === true || Boolean(options.adapterOverrides);
  const configured = await isTursoConfiguredRuntime();
  const [excludedRaw, dbUrl] = await Promise.all([
    envValue("CURIOSITY_EXCLUDED_SERVICES"),
    envValue("TURSO_DATABASE_URL"),
  ]);
  const excluded = new Set(excludedRaw.split(",").map((id) => id.trim()).filter(Boolean));
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();

  // Check if all requested capabilities are already fresh in the isolate cache.
  if (!bypassCache && configured && ttlMs > 0) {
    const cachedAll = capabilities.map(({ id, launched }) => {
      if (!launched) return { serviceId: id, eligible: false, reasonCode: "NOT_LAUNCHED", checkedAt };
      if (excluded.has(id)) return { serviceId: id, eligible: false, reasonCode: "SERVICE_EXCLUDED", checkedAt };
      const key = `${dbUrl}|${id}`;
      const hit = readinessCache.get(key);
      return hit && hit.expiresAt > now ? hit.result : null;
    });
    if (cachedAll.every((entry): entry is CuriosityReadiness => entry !== null)) {
      return cachedAll;
    }
  }

  let reachable = false;
  if (configured) {
    try {
      await withAdapterTimeout(turso("SELECT 1"), timeoutMs);
      reachable = true;
    } catch {
      /* Fail closed when the data source is unavailable. */
    }
  }

  return Promise.all(capabilities.map(async ({ id, launched }) => {
    if (!launched) return { serviceId: id, eligible: false, reasonCode: "NOT_LAUNCHED", checkedAt };
    if (excluded.has(id)) return { serviceId: id, eligible: false, reasonCode: "SERVICE_EXCLUDED", checkedAt };
    if (!reachable) return { serviceId: id, eligible: false, reasonCode: "DATA_UNAVAILABLE", checkedAt };

    const cacheKey = `${dbUrl}|${id}`;
    if (!bypassCache && ttlMs > 0) {
      const hit = readinessCache.get(cacheKey);
      if (hit && hit.expiresAt > now) return hit.result;
    }

    try {
      const checkFn = options.adapterOverrides?.[id] ?? (() => hasCurrentBrowseableOffer(id));
      const eligible = await withAdapterTimeout(checkFn(), timeoutMs);
      const result: CuriosityReadiness = {
        serviceId: id,
        eligible,
        reasonCode: eligible ? "READY" : "NO_VERIFIED_OFFER",
        checkedAt,
      };
      if (!bypassCache && ttlMs > 0) {
        readinessCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, result });
      }
      return result;
    } catch {
      return { serviceId: id, eligible: false, reasonCode: "READINESS_CHECK_FAILED", checkedAt };
    }
  }));
}
