import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { queueProgress, estimateWaitMinutes, waitLabel } = await vite.ssrLoadModule("/lib/campus-engine/progress.ts");

test("an active status marks earlier steps done and later steps upcoming", () => {
  const progress = queueProgress("DRIVER_ARRIVED");
  assert.equal(progress.state, "active");
  assert.equal(progress.status, "DRIVER_ARRIVED");
  assert.deepEqual(progress.steps.map((step) => step.state), ["done", "done", "current", "upcoming", "upcoming"]);
  assert.equal(progress.label, "Driver arrived");
});

test("payment confirmed is the first active step", () => {
  const progress = queueProgress("PAID_WAITING");
  assert.deepEqual(progress.steps.map((step) => step.state), ["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
});

test("terminal and unknown statuses never show a live step", () => {
  for (const status of ["EXPIRED", "PAYMENT_FAILED", "CANCELLED_BY_DRIVER", "NO_SHOW", "PAYMENT_RECEIVED_REVIEW"]) {
    const progress = queueProgress(status);
    assert.equal(progress.state, "terminal", status);
    assert.ok(progress.steps.every((step) => step.state === "upcoming"));
  }
  const unknown = queueProgress("SOMETHING_NEW");
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.label, "Status unavailable");
});

test("lowercase and blank statuses are normalised", () => {
  assert.equal(queueProgress("boarded").state, "active");
  assert.equal(queueProgress("").state, "unknown");
});

test("wait estimate batches riders by vehicle capacity", () => {
  // One trip when nobody is ahead, regardless of capacity.
  assert.equal(estimateWaitMinutes({ peopleAhead: 0, capacity: 4, tripMinutes: 7 }), 7);
  // Five riders ahead with capacity 4 means a second trip.
  assert.equal(estimateWaitMinutes({ peopleAhead: 5, capacity: 4, tripMinutes: 7 }), 14);
  // Nine ahead with capacity 4 means three trips.
  assert.equal(estimateWaitMinutes({ peopleAhead: 9, capacity: 4, tripMinutes: 7 }), 21);
  // A missing capacity must not divide by zero.
  assert.equal(estimateWaitMinutes({ peopleAhead: 0, capacity: 0, tripMinutes: 7 }), 7);
  // Clamped to a sane ceiling.
  assert.equal(estimateWaitMinutes({ peopleAhead: 999, capacity: 1, tripMinutes: 10 }), 180);
});

test("wait labels read naturally at every scale", () => {
  assert.equal(waitLabel(1), "Arriving now");
  assert.equal(waitLabel(2), "Arriving now");
  assert.equal(waitLabel(9), "About 9 min");
  assert.equal(waitLabel(60), "About 1h");
  assert.equal(waitLabel(75), "About 1h 15m");
});
