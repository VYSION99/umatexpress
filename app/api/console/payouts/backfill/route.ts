import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { backfillAccruals } from "@/lib/organizer-payouts";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Rebuilds ledger rows for confirmed bookings that a failed write left without
 * one. Idempotent, admin-only, and bounded: each booking costs a couple of
 * subrequests against a per-invocation budget, so it works in small batches.
 */
export async function POST(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json().catch(() => ({})) as { limit?: number };
    return Response.json({ ok: true, ...await backfillAccruals({ limit: body.limit }) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
