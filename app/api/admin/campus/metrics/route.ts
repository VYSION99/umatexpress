import { requireSuperAdmin } from "@/lib/campus-engine/admin";
import { fail, ok } from "@/lib/campus-engine/responses";
import { notificationQueueHealth } from "@/lib/notifications";
import { readMetrics, utcDay } from "@/lib/observability";

export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request);
    const day = new URL(request.url).searchParams.get("day") || utcDay();
    const [metrics, notifications] = await Promise.all([readMetrics(day), notificationQueueHealth()]);
    return ok({ ...metrics, notifications }, undefined, request);
  } catch (error) {
    return fail(error, request);
  }
}

export const POST = GET;
