import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import {
  approveHostelRefund,
  declineHostelRefund,
  listHostelRefunds,
  recordHostelRefundPayment,
  runHostelRefundReconcile,
  type HostelRefund,
} from "@/lib/hostel-engine/refunds";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The refund desk. Money leaving the platform is an administrator's decision:
 * the queue lists what students asked for, and the levers are approve (at the
 * policy price or a stated override), decline with a reason, record a transfer
 * made outside Paystack, and ask Paystack where a pending refund got to.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-refunds-console", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const status = String(new URL(request.url).searchParams.get("status") || "").trim().toUpperCase();
    const refunds = await listHostelRefunds({ status });
    return Response.json({ ok: true, refunds, summary: summarize(refunds) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const limited = await rateLimit(request, "hostel-refund-console-write", { limit: 90, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as {
      action?: unknown; refundId?: unknown; reason?: unknown; overridePercent?: unknown; reference?: unknown; note?: unknown;
    };
    const action = String(body.action || "").trim().toUpperCase();
    if (action === "RECONCILE") {
      return Response.json({ ok: true, result: await runHostelRefundReconcile({ limit: 10 }), refunds: await listHostelRefunds({ limit: 100 }) }, { headers: NO_STORE });
    }
    const refundId = String(body.refundId || "");
    if (!refundId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the refund to act on.", 400);
    if (action === "APPROVE") {
      const refund = await approveHostelRefund({ refundId, actor: account.email, overridePercent: body.overridePercent, reason: body.reason });
      return Response.json({ ok: true, refund }, { headers: NO_STORE });
    }
    if (action === "DECLINE") {
      const refund = await declineHostelRefund({ refundId, reason: body.reason, actor: account.email });
      return Response.json({ ok: true, refund }, { headers: NO_STORE });
    }
    if (action === "RECORD") {
      const refund = await recordHostelRefundPayment({ refundId, reference: body.reference, note: body.note, actor: account.email });
      return Response.json({ ok: true, refund }, { headers: NO_STORE });
    }
    throw new CampusEngineError("VALIDATION_ERROR", "Unknown refund action.", 400);
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

function summarize(refunds: HostelRefund[]) {
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
