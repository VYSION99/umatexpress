import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import {
  approveCampusRefund,
  declineCampusRefund,
  listCampusRefunds,
  recordCampusRefundPayment,
  runCampusRefundReconcile,
  runCampusUnmatchedRefundSweep,
  type CampusRefund,
} from "@/lib/campus-engine/refunds";
import { requireConsoleRole } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The campus refund desk.
 *
 * Cancelling a seat is the passenger's act, but returning the money is an
 * administrator's: this lists what the cancellation policy recorded and offers
 * the same levers as the hostel desk — approve, decline with a reason, record a
 * transfer made outside Paystack, and ask Paystack where a sent refund got to.
 * The sweep lever is here too, so an operator can clear unmatched seats without
 * waiting for the five-minute cron.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "campus-refunds-console", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const status = String(new URL(request.url).searchParams.get("status") || "").trim().toUpperCase();
    const refunds = await listCampusRefunds({ status });
    return Response.json({ ok: true, refunds, summary: summarize(refunds) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "campus-refund-console-write", { limit: 90, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { action?: unknown; refundId?: unknown; reason?: unknown; reference?: unknown; note?: unknown };
    const action = String(body.action || "").trim().toUpperCase();
    if (action === "RECONCILE") {
      const result = await runCampusRefundReconcile({ limit: 10 });
      return Response.json({ ok: true, result, refunds: await listCampusRefunds({ limit: 100 }) }, { headers: NO_STORE });
    }
    if (action === "SWEEP") {
      const result = await runCampusUnmatchedRefundSweep({ limit: 25 });
      return Response.json({ ok: true, result, refunds: await listCampusRefunds({ limit: 100 }) }, { headers: NO_STORE });
    }
    const refundId = String(body.refundId || "");
    if (!refundId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the refund to act on.", 400);
    if (action === "APPROVE") {
      return Response.json({ ok: true, refund: await approveCampusRefund({ refundId, actor: account.email, note: String(body.note || "") }) }, { headers: NO_STORE });
    }
    if (action === "DECLINE") {
      return Response.json({ ok: true, refund: await declineCampusRefund({ refundId, reason: body.reason, actor: account.email }) }, { headers: NO_STORE });
    }
    if (action === "RECORD") {
      return Response.json({ ok: true, refund: await recordCampusRefundPayment({ refundId, reference: body.reference, note: body.note, actor: account.email }) }, { headers: NO_STORE });
    }
    throw new CampusEngineError("VALIDATION_ERROR", "Unknown refund action.", 400);
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

function summarize(refunds: CampusRefund[]) {
  const count = (status: string) => refunds.filter((refund) => refund.status === status).length;
  const paid = refunds.filter((refund) => refund.status === "PAID");
  return {
    total: refunds.length,
    requested: count("REQUESTED"),
    approved: count("APPROVED"),
    paid: count("PAID"),
    declined: count("DECLINED"),
    failed: count("FAILED"),
    paidAmount: paid.reduce((total, refund) => total + Number(refund.amount || 0), 0),
  };
}
