/**
 * The one place an amount is divided between the platform and a payee.
 *
 * Every product that keeps a share of what a customer pays — vacationRide
 * organizers, campusRide drivers — divides it the same way, and the net is
 * always derived from the gross and the commission rather than computed
 * separately, so a rounding can never leave the two out of step by a pesewa.
 * Keeping it here rather than in one product's ledger is what stops the second
 * product from inventing a slightly different split.
 */

/** `round(gross * bps / 10000)`, with the net derived from the two so the split can never be a pesewa out. */
export function splitCommission(gross: number, commissionBps: number) {
  const safeGross = Math.max(0, Math.round(Number(gross) || 0));
  const safeBps = Math.max(0, Math.min(10_000, Math.round(Number(commissionBps) || 0)));
  const commission = Math.round((safeGross * safeBps) / 10_000);
  return { gross: safeGross, commission, net: safeGross - commission };
}
