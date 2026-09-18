import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// Renders through the built Worker, so this covers the production path: the
// host boundary, the console pages, and the fact that they ship together.
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
const ctx = { waitUntil() {}, passThroughOnException() {} };
const assets = { fetch: async () => new Response("Not found", { status: 404 }) };

async function loadWorker() {
  if (!existsSync(workerUrl)) return null;
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

test("the built worker serves the console sign-in page", async () => {
  const worker = await loadWorker();
  if (!worker) { test.skip("Run npm run build before checking rendered console HTML."); return; }

  const response = await worker.fetch(
    new Request("http://localhost/console/login", { headers: { accept: "text/html" } }),
    { ASSETS: assets },
    ctx,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /UMATEXPRESS CONSOLE/);
  assert.match(html, /console-auth-card/);
  // The console must never be indexable.
  assert.match(html, /noindex/i);
});

test("the built worker applies the console host boundary", async () => {
  const worker = await loadWorker();
  if (!worker) { test.skip("Run npm run build before checking the console boundary."); return; }

  const env = { ASSETS: assets, CONSOLE_HOSTS: "console.example.test" };
  const consolePage = await worker.fetch(
    new Request("https://console.example.test/console", { headers: { accept: "text/html" } }),
    env,
    ctx,
  );
  assert.equal(consolePage.status, 200);

  const publicConsole = await worker.fetch(
    new Request("https://umatexpress.example.workers.dev/console", { headers: { accept: "text/html" } }),
    env,
    ctx,
  );
  assert.equal(publicConsole.status, 404);

  const root = await worker.fetch(new Request("https://console.example.test/", { headers: { accept: "text/html" } }), env, ctx);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "https://console.example.test/console");

  const publicSite = await worker.fetch(new Request("https://umatexpress.example.workers.dev/", { headers: { accept: "text/html" } }), env, ctx);
  assert.equal(publicSite.status, 200);
});
