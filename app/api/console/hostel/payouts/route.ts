import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getHostelLandlord } from "@/lib/hostel-engine/landlord";
import {
  getHostelPayoutAccount, hostelPayoutStatement, hostelPayoutAutoState, listHostelPayoutLandlords, platformHostelPayoutBalance,
  recordHostelPayoutBatch, runHostelPayoutReconcileJob, sendHostelPayoutBatch,
} from "@/lib/hostel-engine/payouts";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The hostel money desk. Admin only, because the entries here are other
 * people's earnings: what each landlord has accrued, which part has left its
 * release window, and the batch that marks a transfer as made.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const landlordId = String(new URL(request.url).searchParams.get("landlordId") || "").trim();
    if (!landlordId) {
      const [{ landlords, totals }, balance, auto] = await Promise.all([
        listHostelPayoutLandlords(),
        platformHostelPayoutBalance(),
        hostelPayoutAutoState(),
      ]);
      return Response.json({ ok: true, landlords, totals, balance, auto: { enabled: auto.enabled, source: auto.source } }, { headers: NO_STORE });
    }
    const [landlord, statement, account] = await Promise.all([
      getHostelLandlord(landlordId),
      hostelPayoutStatement(landlordId),
      getHostelPayoutAccount(landlordId),
    ]);
    return Response.json({ ok: true, landlord, account, ...statement }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-payout-record", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { action?: unknown; landlordId?: unknown; reference?: unknown; note?: unknown };
    const action = String(body.action || "RECORD").trim().toUpperCase();
    if (action === "RECONCILE") {
      // The webhook is the fast path; this is the button an administrator
      // presses when a transfer looks stuck.
      return Response.json({ ok: true, action, result: await runHostelPayoutReconcileJob({ limit: 6 }) }, { headers: NO_STORE });
    }
    const landlordId = String(body.landlordId || "");
    if (!landlordId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord to pay.", 400);
    if (action === "SEND") {
      // Paystack sends the money; the entries are only released when it lands.
      const result = await sendHostelPayoutBatch({ landlordId, note: body.note, actor: account.email });
      return Response.json({ ok: true, action, ...result }, { status: 201, headers: NO_STORE });
    }
    if (action !== "RECORD") throw new CampusEngineError("VALIDATION_ERROR", "Unknown payout action.", 400);
    const batch = await recordHostelPayoutBatch({ landlordId, reference: body.reference, note: body.note, actor: account.email });
    return Response.json({ ok: true, batch }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
