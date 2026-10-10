/** Historical payments may predate fee snapshots. Never invent their split or
 * recompute it using today's tariff; the stored total is still authoritative. */
export function paymentReceipt(total: unknown, fare: unknown, fee: unknown) {
  const totalAmount = Number(total);
  const fareAmount = Number(fare);
  const feeAmount = Number(fee);
  const complete = fare != null && fee != null && [totalAmount, fareAmount, feeAmount].every(Number.isSafeInteger)
    && totalAmount > 0 && fareAmount > 0 && feeAmount >= 0 && fareAmount + feeAmount === totalAmount;
  return { totalAmount, fareAmount: complete ? fareAmount : null, feeAmount: complete ? feeAmount : null };
}
