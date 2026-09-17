import type { CampusCorridor } from "@/lib/campus-ride";
import { calculatePaystackCharge } from "@/lib/paystack";

export type CampusFareQuote = {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  serviceFee: number;
  subtotal: number;
  paystackFee: number;
  total: number;
  currency: "GHS";
};

export function quoteCampusFare(input: { corridor?: CampusCorridor; distanceKm?: number; minutes?: number; paystackFeePercent?: number }) {
  const baseFare = input.corridor?.fare || 500;
  const distanceFare = Math.max(0, Math.round((input.distanceKm || 0) * 100));
  const timeFare = Math.max(0, Math.round((input.minutes || input.corridor?.estimatedMinutes || 0) * 10));
  const serviceFee = 0;
  const subtotal = Math.max(baseFare, baseFare + distanceFare + timeFare + serviceFee);
  const paystack = calculatePaystackCharge(subtotal, input.paystackFeePercent);
  return { baseFare, distanceFare, timeFare, serviceFee, subtotal, paystackFee: paystack.feeAmount, total: paystack.totalAmount, currency: "GHS" as const };
}
