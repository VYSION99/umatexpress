import type { CampusCorridor } from "@/lib/campus-ride";
import { calculatePaystackCharge } from "@/lib/paystack";

/**
 * The price of one campus seat: the corridor's published tariff, plus the
 * payment rail's fee.
 *
 * The tariff is flat and it is the whole price. The cost model that decides
 * whether a tariff is survivable lives in `lib/campus-fare-math.ts` and is
 * deliberately not consulted here — a floor that moved the passenger's price
 * would be a surge with a different name. The two are reconciled when a fare is
 * saved, never when one is charged.
 *
 * A corridor with no tariff is not priced at a default: `subtotal` is 0 and the
 * caller refuses the booking. The fallback that used to live here priced a
 * GH₵50 corridor at GH₵5 and paid the driver on that basis.
 */
export type CampusFareQuote = {
  baseFare: number;
  subtotal: number;
  paystackFee: number;
  total: number;
  currency: "GHS";
};

export function quoteCampusFare(input: { corridor?: CampusCorridor; paystackFeePercent?: number }): CampusFareQuote {
  const baseFare = Math.max(0, Math.round(Number(input.corridor?.fare) || 0));
  if (!baseFare) return { baseFare: 0, subtotal: 0, paystackFee: 0, total: 0, currency: "GHS" as const };
  const paystack = calculatePaystackCharge(baseFare, input.paystackFeePercent);
  return { baseFare, subtotal: baseFare, paystackFee: paystack.feeAmount, total: paystack.totalAmount, currency: "GHS" as const };
}
