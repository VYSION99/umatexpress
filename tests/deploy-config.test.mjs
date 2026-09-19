import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deployConfig } from "../scripts/write-deploy-config.mjs";

/** A miniature build output: the script only reads the shape, not the values. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umx-deploy-"));
  const input = path.join(dir, "dist", "server", "wrangler.json");
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, JSON.stringify({
    name: "mate",
    triggers: { crons: ["*/5 * * * *"] },
    queues: {
      producers: [{ binding: "NOTIFICATION_QUEUE", queue: "umatexpress-notifications" }],
      consumers: [{ queue: "umatexpress-notifications", max_batch_size: 10 }],
    },
    vars: { CLOUDFLARE_AI_BINDING: "AI" },
    r2_buckets: [{ binding: "PRIVATE_BUCKET", bucket_name: "umatexpress-private" }],
  }));
  return { dir, input, output: path.join(dir, "dist", "server", "deploy.json") };
}

function write(fixture, role, hosts = "", domain = "") {
  return deployConfig(fixture.input, { name: "umatexpress", role, consoleDomain: domain, consoleHosts: hosts }).config;
}

test("the console Worker carries no crons and no queue consumer", () => {
  const fixtureDir = fixture();
  const config = write(fixtureDir, "console", "console-umatexpress.example.workers.dev");
  // Exactly one Worker may run the jobs and consume the queue: a second cron
  // would double every settlement, and a second consumer every message.
  assert.equal(config.triggers, undefined);
  assert.equal(config.queues.consumers, undefined);
  assert.deepEqual(config.queues.producers, [{ binding: "NOTIFICATION_QUEUE", queue: "umatexpress-notifications" }]);
  assert.equal(config.vars.CONSOLE_HOSTS, "console-umatexpress.example.workers.dev");
  assert.equal(config.name, "umatexpress");
});

test("the client Worker keeps the jobs and refuses console paths via CONSOLE_HOSTS", () => {
  const fixtureDir = fixture();
  const config = write(fixtureDir, "client", "console-umatexpress.example.workers.dev");
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *"]);
  assert.equal(config.queues.consumers.length, 1);
  assert.equal(config.vars.CONSOLE_HOSTS, "console-umatexpress.example.workers.dev");
  // The custom domain belongs to the console Worker, never the client.
  assert.equal(config.routes, undefined);
});

test("a single-Worker deployment is unchanged and keeps the console domain route", () => {
  const fixtureDir = fixture();
  const plain = write(fixtureDir, "single");
  assert.deepEqual(plain.triggers.crons, ["*/5 * * * *"]);
  assert.equal(plain.vars.CONSOLE_HOSTS, undefined);
  assert.equal(plain.routes, undefined);

  const routed = write(fixtureDir, "single", "", "console.umatexpress.com");
  assert.deepEqual(routed.routes, [{ pattern: "console.umatexpress.com/*", custom_domain: true }]);
});
