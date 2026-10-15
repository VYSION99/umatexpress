import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
const root = process.cwd();
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createCinemaClock } = await vite.ssrLoadModule("/lib/cinema-engine/clock.ts");
const { expectedPosition } = await vite.ssrLoadModule("/lib/cinema-engine/sync.ts");
const { putCinemaPart } = await vite.ssrLoadModule("/components/cinema/transfer.ts");

test("playback uses measured server time despite device wall-clock skew", () => {
  let monotonic = 100;
  const clock = createCinemaClock(() => monotonic);
  clock.sample(1_000_000, 80);
  monotonic += 3000;
  const playback = { positionSeconds: 30, isPlaying: true, updatedAt: 1_000_000, durationSeconds: 300 };
  assert.equal(expectedPosition(playback, clock.now()), 33.01);
  clock.sample(1_090_000, 0); // reject a worse latency sample
  assert.equal(expectedPosition(playback, clock.now()), 33.01);
});

test("part transfers retry transient failures with identical URL and bytes", async () => {
  const original = globalThis.fetch;
  const calls = [];
  const body = new Blob(["video part"]);
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return new Response("{}", { status: calls.length === 1 ? 503 : 200 }); };
  try {
    assert.equal((await putCinemaPart("/part?n=2", body)).status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], calls[1][0]);
    assert.equal(calls[0][1].body, body);
    assert.equal(calls[1][1].body, body);
  } finally { globalThis.fetch = original; }
});

test("part transfers do not retry authorization failures", async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response("denied", { status: 403 }); };
  try { assert.equal((await putCinemaPart("/part", new Blob())).status, 403); assert.equal(count, 1); }
  finally { globalThis.fetch = original; }
});
