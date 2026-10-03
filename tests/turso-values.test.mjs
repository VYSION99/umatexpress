import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const previousUrl = process.env.TURSO_DATABASE_URL;
const previousToken = process.env.TURSO_AUTH_TOKEN;
const previousFetch = globalThis.fetch;
process.env.TURSO_DATABASE_URL = "https://turso-values-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
const requests = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  return {
    ok: true,
    json: async () => ({ results: body.requests.filter(item => item.type !== "close").map(item => ({
      type: "ok",
      response: { result: item.type === "batch"
        ? { step_results: item.batch.steps.map(() => ({})), step_errors: item.batch.steps.map(() => null) }
        : {} },
    })) }),
  };
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => {
  await vite.close();
  globalThis.fetch = previousFetch;
  if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
  if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
});
const { turso, tursoReadBatch, tursoTransaction } = await vite.ssrLoadModule("/lib/turso.ts");
const coordinateArgs = [
  { type: "float", value: 5.3009 },
  { type: "float", value: -1.9897 },
  { type: "integer", value: "35" },
  { type: "text", value: "Green View" },
  { type: "null" },
];
const values = [5.3009, -1.9897, 35, "Green View", null];

test("fractional property coordinates use Hrana floats in direct writes, reads, and transactions", async () => {
  await turso("UPDATE hostel_properties SET latitude=?,longitude=?", values);
  assert.deepEqual(requests.at(-1).requests[0].stmt.args, coordinateArgs);
  await tursoReadBatch([{ sql: "SELECT latitude FROM hostel_properties WHERE latitude=?", args: values }]);
  assert.deepEqual(requests.at(-1).requests[0].stmt.args, coordinateArgs);
  await tursoTransaction([{ sql: "UPDATE hostel_properties SET latitude=?,longitude=?", args: values }]);
  assert.deepEqual(requests.at(-1).requests[0].batch.steps[1].stmt.args, coordinateArgs);
});

test("non-finite database numbers fail before a request is sent", async () => {
  const before = requests.length;
  await assert.rejects(() => turso("SELECT ?", [Number.NaN]), TypeError);
  assert.equal(requests.length, before);
});
