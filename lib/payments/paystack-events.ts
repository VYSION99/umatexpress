import { markCampusRidePaymentFailed, markCampusRidePaymentSuccessful } from "@/lib/campus-engine/rides";
import { failHostelWebhookPayment, settleHostelWebhookPayment } from "@/lib/hostel-engine/settle";
import { applyHostelPaystackTransferEvent } from "@/lib/hostel-engine/payouts";
import { applyCampusRefundEvent } from "@/lib/campus-engine/refunds";
import { applyHostelRefundEvent } from "@/lib/hostel-engine/refunds";

import { applyPaystackTransferEvent } from "@/lib/organizer-payouts";
import { markSuccessful, markFailed } from "@/lib/payments/vacation";
import { applyFoodRefundEvent, failFoodPayment, settleFoodPayment } from "@/lib/food/payments";
import { failCinemaRoomPlanPayment, refundCinemaRoomPlanPayment, settleCinemaRoomPlanPayment } from "@/lib/cinema-engine/room-plan-subscriptions";
import { isRefundEvent, paystackRefundIdentity } from "@/lib/payments/paystack-refund-identity";

export type PaystackWebhook = {
  event?: string;
  data?: {
    id?: number;
    reference?: string;
    amount?: number;
    currency?: string;
    status?: string;
    gateway_response?: string;
    /** What the rail charged for the charge, in pesewas. */
    fees?: number;
    transfer_code?: string;
    reason?: string;
    /** Refund payloads carry the refund's own reference and its charge. */
    transaction?: string | { reference?: string };
    transaction_reference?: string;
    refund_reference?: string;
  };
};

/** Paystack sends payout results to the same endpoint as payments. */
const TRANSFER_EVENTS = ["transfer.success", "transfer.failed", "transfer.reversed"] as const;

function isTransferEvent(event: string | undefined): event is (typeof TRANSFER_EVENTS)[number] {
  return (TRANSFER_EVENTS as readonly string[]).includes(String(event || ""));
}

export async function processPaystackEvent(event: PaystackWebhook) {
  const reference = String(event.data?.reference || "").trim();
  const transactionId = event.data?.id ? String(event.data.id) : "";
  const amount = Number(event.data?.amount || 0);
  if (isRefundEvent(event.event)) {
    if (event.event === "refund.processed") {
      const { chargeReference, refundId } = paystackRefundIdentity(event.data);
      const cinema = await refundCinemaRoomPlanPayment({ reference: chargeReference, refundId, amount, currency: String(event.data?.currency || "MISSING") });
      if (cinema.handled) return cinema;
    }
    const input = { event: String(event.event), reference, status: event.data?.status, amount, currency: String(event.data?.currency || "MISSING") };
    const food = await applyFoodRefundEvent(input);
    if (food.handled) return food;
    const hostel = await applyHostelRefundEvent(input);
    return hostel.handled ? hostel : await applyCampusRefundEvent(input);
  }
  if (isTransferEvent(event.event)) {
    const input = { event: event.event, data: (event.data || {}) as Record<string, unknown> };
    const vacation = await applyPaystackTransferEvent(input);
    return vacation.handled ? vacation : await applyHostelPaystackTransferEvent(input);
  }
  if (event.event === "charge.success" && event.data?.status === "success") {
    // A successful settlement without a currency cannot safely be matched to a
    // GHS quote. Passing an explicit sentinel sends it to the product's review
    // state rather than treating missing data as an implicit match.
    const currency = String(event.data?.currency || "MISSING").toUpperCase();
    const cinema = await settleCinemaRoomPlanPayment({ reference, amount, currency });
    if (cinema.handled) return cinema;
    const vacation = await markSuccessful(reference, amount, currency, transactionId);
    if (vacation.handled) return vacation;
    const campus = await markCampusRidePaymentSuccessful(reference, amount, transactionId, "payment-inbox", Number(event.data?.fees || 0), currency);
    if (campus.handled) return campus;
    const food = await settleFoodPayment(reference, amount, currency, transactionId);
    if (food.handled) return food;
    return settleHostelWebhookPayment({ reference, amount, currency, transactionId, source: "webhook" });
  }
  const reason = event.data?.gateway_response || "PAYSTACK_PAYMENT_FAILED";
  const cinema = await failCinemaRoomPlanPayment(reference);
  if (cinema.handled) return cinema;
  const vacation = await markFailed(reference, reason, transactionId);
  if (vacation.handled) return vacation;
  const campus = await markCampusRidePaymentFailed(reference, reason, transactionId, "payment-inbox");
  if (campus.handled) return campus;
  const food = await failFoodPayment(reference, reason, transactionId);
  return food.handled ? food : await failHostelWebhookPayment({ reference, reason, transactionId });
}

export function actionablePaystackEvent(event: PaystackWebhook) {
  return isRefundEvent(event.event) || isTransferEvent(event.event)
    || event.event === "charge.failed"
    || (event.event === "charge.success" && event.data?.status === "success");
}
