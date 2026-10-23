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

test("boundary responses and image errors carry security headers", async () => {
  const worker = await loadWorker();
  assert.ok(worker, "Build the Worker first");
  for (const url of ["https://console.example.test/", "https://public.example.test/console", "https://public.example.test/_vinext/image"]) {
    const response = await worker.fetch(new Request(url), { CONSOLE_HOSTS: "console.example.test" }, ctx);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("strict-transport-security"), /max-age=31536000/);
  }
});

test("public aliases redirect with method-preserving status and intact path/query", async () => {
  const worker = await loadWorker();
  assert.ok(worker, "Build the Worker first");
  const response = await worker.fetch(new Request("http://www.example.test/payment/callback?reference=abc", { method: "POST" }), { CANONICAL_HOST: "example.test", HOST_ALIASES: "www.example.test" }, ctx);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://example.test/payment/callback?reference=abc");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("static assets receive headers and aliases redirect before asset lookup", async () => {
  const worker = await loadWorker();
  let calls = 0;
  const env = { CANONICAL_HOST: "example.test", HOST_ALIASES: "www.example.test", ASSETS: { fetch: async () => { calls++; return new Response("asset", { headers: { "Content-Type": "text/css" } }); } } };
  const response = await worker.fetch(new Request("https://example.test/assets/site.css"), env, ctx);
  assert.equal(await response.text(), "asset");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const redirect = await worker.fetch(new Request("https://www.example.test/assets/site.css?v=2"), env, ctx);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://example.test/assets/site.css?v=2");
  assert.equal(calls, 1);
});
