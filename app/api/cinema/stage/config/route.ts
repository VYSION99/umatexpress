import { fail, ok } from "@/lib/campus-engine/responses";
import { freeJaasPolicy } from "@/lib/cinema-streaming/entitlements";
import { jaasRuntime } from "@/lib/cinema-streaming/jaas";

const PUBLIC_CACHE = { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" };

export async function GET(request: Request) {
  try {
    const [policy, runtime] = await Promise.all([freeJaasPolicy(), jaasRuntime()]);
    return ok({
      managedStage: {
        available: policy.enabled && runtime.configured,
        maxUniqueParticipants: policy.maxStageUnique,
        maxDurationMinutes: policy.maxDurationMinutes,
        freePeriodDays: policy.periodDays,
      },
    }, { headers: PUBLIC_CACHE }, request);
  } catch (error) { return fail(error, request); }
}
