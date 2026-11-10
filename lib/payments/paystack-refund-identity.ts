import type { PaystackWebhook } from "./paystack-events";

const REFUND_EVENTS = ["refund.processed", "refund.pending", "refund.processing", "refund.failed"] as const;

export function isRefundEvent(event: string | undefined): event is (typeof REFUND_EVENTS)[number] {
  return (REFUND_EVENTS as readonly string[]).includes(String(event || ""));
}

export function paystackRefundIdentity(data: PaystackWebhook["data"]) {
  const chargeReference = String(data?.transaction_reference || (typeof data?.transaction === "string" ? data.transaction : data?.transaction?.reference) || "").trim();
  const reference = String(data?.refund_reference || data?.reference || "").trim();
  return { chargeReference, refundId: String(data?.id || (reference !== chargeReference ? reference : "")).trim() };
}
