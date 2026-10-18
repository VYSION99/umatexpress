export type DeliveryEstimateInput = {
  maximumInvited: number;
  expectedConcurrent: number;
  expectedUniqueViewers: number;
  expectedViewingMinutes: number;
  /** USD per viewer-minute expressed in millionths of a dollar. $0.001 = 1,000. */
  providerRateMicroUsd: number;
  /** USD per viewer-minute expressed in millionths of a dollar. $0.002 = 2,000. */
  retailRateMicroUsd: number;
  /** Ghana pesewas for USD 1. Set by an administrator from the documented FX source. */
  usdToGhsPesewas: number;
  /** Optional reservation buffer. 11,000 reserves 110% of the retail estimate. */
  reserveBasisPoints?: number;
  minimumChargePesewas?: number;
};

export type DeliveryEstimate = {
  maximumInvited: number;
  expectedConcurrent: number;
  expectedUniqueViewers: number;
  expectedViewingMinutes: number;
  estimatedViewerMinutes: number;
  estimatedProviderCostMicroUsd: number;
  estimatedRetailMicroUsd: number;
  estimatedProviderCostPesewas: number;
  estimatedRetailPesewas: number;
  reservationPesewas: number;
  minimumApplied: boolean;
  /** Estimates remain provisional until provider usage is reconciled. */
  final: false;
};

function integer(value: number, label: string, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${label} must be a safe integer of at least ${min}.`);
  return value;
}

function safeNumber(value: bigint, label: string) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} is too large to represent safely.`);
  return Number(value);
}

function ceilDivide(value: bigint, divisor: bigint) {
  return (value + divisor - BigInt(1)) / divisor;
}

/**
 * Produces a planning estimate only. Provider-reported delivered minutes remain
 * authoritative for the final charge and reconciliation record.
 */
export function estimateStreamingDelivery(input: DeliveryEstimateInput): DeliveryEstimate {
  const maximumInvited = integer(input.maximumInvited, "Maximum invited audience");
  const expectedConcurrent = integer(input.expectedConcurrent, "Expected concurrent audience");
  const expectedUniqueViewers = integer(input.expectedUniqueViewers, "Expected unique viewers");
  const expectedViewingMinutes = integer(input.expectedViewingMinutes, "Expected viewing minutes", 1);
  const providerRateMicroUsd = integer(input.providerRateMicroUsd, "Provider rate");
  const retailRateMicroUsd = integer(input.retailRateMicroUsd, "Retail rate");
  const usdToGhsPesewas = integer(input.usdToGhsPesewas, "USD to GHS rate", 1);
  const reserveBasisPoints = integer(input.reserveBasisPoints ?? 10_000, "Reservation basis points", 10_000);
  const minimumChargePesewas = integer(input.minimumChargePesewas ?? 0, "Minimum charge");

  if (expectedConcurrent > maximumInvited || expectedUniqueViewers > maximumInvited) {
    throw new RangeError("Expected audiences cannot exceed the maximum invited audience.");
  }
  if (retailRateMicroUsd < providerRateMicroUsd) {
    throw new RangeError("Retail delivery rate cannot be below the provider delivery rate.");
  }

  const viewerMinutes = BigInt(expectedUniqueViewers) * BigInt(expectedViewingMinutes);
  const providerMicroUsd = viewerMinutes * BigInt(providerRateMicroUsd);
  const retailMicroUsd = viewerMinutes * BigInt(retailRateMicroUsd);
  // micro-USD × pesewas/USD ÷ 1,000,000 = pesewas.
  const providerPesewas = ceilDivide(providerMicroUsd * BigInt(usdToGhsPesewas), BigInt(1_000_000));
  const retailPesewas = ceilDivide(retailMicroUsd * BigInt(usdToGhsPesewas), BigInt(1_000_000));
  const chargePesewas = retailPesewas > BigInt(minimumChargePesewas) ? retailPesewas : BigInt(minimumChargePesewas);
  const reservationPesewas = ceilDivide(chargePesewas * BigInt(reserveBasisPoints), BigInt(10_000));

  return {
    maximumInvited,
    expectedConcurrent,
    expectedUniqueViewers,
    expectedViewingMinutes,
    estimatedViewerMinutes: safeNumber(viewerMinutes, "Viewer minutes"),
    estimatedProviderCostMicroUsd: safeNumber(providerMicroUsd, "Provider estimate"),
    estimatedRetailMicroUsd: safeNumber(retailMicroUsd, "Retail estimate"),
    estimatedProviderCostPesewas: safeNumber(providerPesewas, "Provider GHS estimate"),
    estimatedRetailPesewas: safeNumber(retailPesewas, "Retail GHS estimate"),
    reservationPesewas: safeNumber(reservationPesewas, "Credit reservation"),
    minimumApplied: retailPesewas < BigInt(minimumChargePesewas),
    final: false,
  };
}

