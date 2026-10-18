import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
const { estimateStreamingDelivery } = await vite.ssrLoadModule("/lib/cinema-streaming/pricing.ts");

test.after(async () => vite.close());

test("estimates delivery with integer money and a reservation buffer", () => {
  const estimate = estimateStreamingDelivery({
    maximumInvited: 500,
    expectedConcurrent: 400,
    expectedUniqueViewers: 400,
    expectedViewingMinutes: 120,
    providerRateMicroUsd: 1_000,
    retailRateMicroUsd: 2_000,
    usdToGhsPesewas: 1_500,
    reserveBasisPoints: 11_000,
  });

  assert.equal(estimate.estimatedViewerMinutes, 48_000);
  assert.equal(estimate.estimatedProviderCostMicroUsd, 48_000_000);
  assert.equal(estimate.estimatedRetailMicroUsd, 96_000_000);
  assert.equal(estimate.estimatedProviderCostPesewas, 72_000);
  assert.equal(estimate.estimatedRetailPesewas, 144_000);
  assert.equal(estimate.reservationPesewas, 158_400);
  assert.equal(estimate.final, false);
});

test("applies a configured minimum and rejects loss-making or impossible estimates", () => {
  const estimate = estimateStreamingDelivery({
    maximumInvited: 20,
    expectedConcurrent: 5,
    expectedUniqueViewers: 10,
    expectedViewingMinutes: 30,
    providerRateMicroUsd: 1_000,
    retailRateMicroUsd: 2_000,
    usdToGhsPesewas: 1_500,
    minimumChargePesewas: 2_000,
  });
  assert.equal(estimate.minimumApplied, true);
  assert.equal(estimate.reservationPesewas, 2_000);

  assert.throws(() => estimateStreamingDelivery({
    maximumInvited: 100, expectedConcurrent: 101, expectedUniqueViewers: 50, expectedViewingMinutes: 60,
    providerRateMicroUsd: 1_000, retailRateMicroUsd: 2_000, usdToGhsPesewas: 1_500,
  }), /cannot exceed/);
  assert.throws(() => estimateStreamingDelivery({
    maximumInvited: 100, expectedConcurrent: 50, expectedUniqueViewers: 50, expectedViewingMinutes: 60,
    providerRateMicroUsd: 2_000, retailRateMicroUsd: 1_000, usdToGhsPesewas: 1_500,
  }), /cannot be below/);
});

