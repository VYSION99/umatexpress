import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

process.env.TURSO_DATABASE_URL = "https://schema-cost-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const MARKER_QUERY = /SELECT version FROM campus_schema_meta/;
const MARKER_WRITE = /INSERT OR REPLACE INTO campus_schema_meta/;

/**
 * Stands in for Turso and records every request the schema pass makes. The
 * marker only comes back filled in when `version` is supplied, which is how a
 * database that has already been migrated behaves.
 */
function fakeTurso(version) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const results = body.requests
      .filter((request) => request.type === "execute")
      .map((request) => {
        if (!MARKER_QUERY.test(request.stmt.sql)) return { type: "ok", response: { result: {} } };
        const cols = [{ name: "version" }];
        return { type: "ok", response: { result: { cols, rows: version ? [[{ type: "text", value: version }]] : [] } } };
      });
    results.push({ type: "ok" });
    return { ok: true, json: async () => ({ results }) };
  };
  return calls;
}

async function loadCampusRide() {
  const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
  return { vite, module: await vite.ssrLoadModule("/lib/campus-ride.ts") };
}

const statementsIn = (call) => call.requests.filter((request) => request.type === "execute");

test("the first schema pass sends every statement in one batched request", async () => {
  const calls = fakeTurso(null);
  const { vite, module } = await loadCampusRide();
  try {
    await module.ensureCampusRideTables();
    // One request to read the marker, one carrying the whole schema, one to
    // record the version. The old pass issued a request per statement.
    assert.equal(calls.length, 3, "expected exactly three requests for the first pass");
    assert.ok(statementsIn(calls[1]).length >= 30, "the schema pass should batch every statement into a single request");

    await module.ensureCampusRideTables();
    assert.equal(calls.length, 3, "a warm isolate must not repeat the schema pass");
  } finally {
    await vite.close();
  }
});

test("a cold isolate reads the marker and stops", async () => {
  const firstCalls = fakeTurso(null);
  const first = await loadCampusRide();
  let version;
  try {
    await first.module.ensureCampusRideTables();
    const write = firstCalls.flatMap(statementsIn).map((request) => request.stmt.sql).find((sql) => MARKER_WRITE.test(sql));
    version = write?.match(/VALUES \('campusRide','([^']+)'/)?.[1];
    assert.ok(version, "the first pass should record a schema version");
  } finally {
    await first.vite.close();
  }

  // A second isolate on a database that already carries the version must not
  // replay the schema: one subrequest is the whole cost.
  const coldCalls = fakeTurso(version);
  const cold = await loadCampusRide();
  try {
    await cold.module.ensureCampusRideTables();
    assert.equal(coldCalls.length, 1, "a migrated database should cost a single subrequest");
    await cold.module.ensureCampusRideTables();
    assert.equal(coldCalls.length, 1);
  } finally {
    await cold.vite.close();
  }
});
