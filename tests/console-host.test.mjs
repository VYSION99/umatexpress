import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const {
  parseConsoleHosts,
  isConsoleNativePath,
  isConsoleSurfacePath,
  isFrameworkAssetPath,
  isLoopbackHost,
  consoleHostAction,
  consoleBoundaryResponse,
} = await vite.ssrLoadModule("/lib/console-hosts.ts");

const CONSOLE = ["console.umatexpress.com"];
const PUBLIC = "umatexpress.acmdevelopers2020.workers.dev";

test("console hosts are parsed from a comma-separated list", () => {
  assert.deepEqual(parseConsoleHosts("console.umatexpress.com, UMaTeXPRESS.acmdevelopers2020.workers.dev "), ["console.umatexpress.com", "umatexpress.acmdevelopers2020.workers.dev"]);
  assert.deepEqual(parseConsoleHosts("https://console.umatexpress.com/"), ["console.umatexpress.com"]);
  assert.deepEqual(parseConsoleHosts(""), []);
  assert.deepEqual(parseConsoleHosts(undefined), []);
});

test("the console entry point redirects from the console root", () => {
  assert.deepEqual(consoleHostAction("console.umatexpress.com", "/", CONSOLE), { action: "redirect", location: "/console" });
  assert.deepEqual(consoleHostAction("console.umatexpress.com", "/console/login", CONSOLE), { action: "serve" });
});

test("the console origin serves console work and refuses the public site", () => {
  for (const path of ["/console", "/console/change-password", "/api/console/session", "/admin", "/admin/vacation", "/api/admin/bookings", "/driver", "/api/driver/me", "/api/trips/schedule", "/api/campus/ai"]) {
    assert.deepEqual(consoleHostAction("console.umatexpress.com", path, CONSOLE), { action: "serve" }, `${path} should be served on the console host`);
  }
  for (const path of ["/vacation", "/campus", "/api/auth/student", "/api/campus/queue/initialize", "/api/payments/webhook", "/api/trips/availability", "/sw.js"]) {
    assert.deepEqual(consoleHostAction("console.umatexpress.com", path, CONSOLE), { action: "not-found" }, `${path} should not be served on the console host`);
  }
});

test("console-native paths are never reachable on the public host", () => {
  for (const path of ["/console", "/console/login", "/api/console/session"]) {
    assert.deepEqual(consoleHostAction(PUBLIC, path, CONSOLE), { action: "not-found" }, `${path} must be refused publicly`);
  }
  for (const path of ["/", "/vacation", "/admin", "/api/trips/schedule", "/api/payments/webhook"]) {
    assert.deepEqual(consoleHostAction(PUBLIC, path, CONSOLE), { action: "serve" }, `${path} must keep working publicly`);
  }
});

test("local development and an unconfigured deployment are not locked out", () => {
  assert.deepEqual(consoleHostAction("127.0.0.1:5190", "/console", []), { action: "serve" });
  assert.deepEqual(consoleHostAction("localhost:5190", "/api/console/session", CONSOLE), { action: "serve" });
  // Local development stays boundary-free even when the console host is set,
  // otherwise /vacation and /campus would 404 on the developer's machine.
  assert.deepEqual(consoleHostAction("127.0.0.1", "/", CONSOLE), { action: "serve" });
  assert.deepEqual(consoleHostAction("localhost:5190", "/vacation", CONSOLE), { action: "serve" });
  // Before the boundary is configured every host keeps working, including the console paths.
  assert.deepEqual(consoleHostAction(PUBLIC, "/console", []), { action: "serve" });
});

test("static assets are allowed on the console and the service worker is not", () => {
  for (const path of ["/assets/main.js", "/favicon.svg", "/logo.svg", "/manifest.webmanifest", "/.well-known/security.txt"]) {
    assert.equal(isFrameworkAssetPath(path), true, `${path} should be an asset`);
    assert.deepEqual(consoleHostAction("console.umatexpress.com", path, CONSOLE), { action: "serve" });
  }
  assert.equal(isFrameworkAssetPath("/sw.js"), false);
});

test("console path classification is prefix-complete, not accidental", () => {
  assert.equal(isConsoleNativePath("/console"), true);
  assert.equal(isConsoleNativePath("/consolexyz"), false);
  assert.equal(isConsoleSurfacePath("/api/campus/ai"), true);
  assert.equal(isConsoleSurfacePath("/api/campus/queue"), false);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("console.umatexpress.com"), false);
});

test("the boundary response is what the worker returns verbatim", () => {
  const hosts = "console.example.test";

  const blocked = consoleBoundaryResponse(new Request("https://console.example.test/vacation"), hosts);
  assert.equal(blocked.status, 404);
  assert.match(blocked.headers.get("cache-control") || "", /no-store/);

  const redirect = consoleBoundaryResponse(new Request("https://console.example.test/"), hosts);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://console.example.test/console");

  const publicConsole = consoleBoundaryResponse(new Request("https://umatexpress.example.test/api/console/session"), hosts);
  assert.equal(publicConsole.status, 404);

  // Unconfigured and loopback requests continue to the app untouched.
  assert.equal(consoleBoundaryResponse(new Request("https://umatexpress.example.test/api/console/session"), ""), null);
  assert.equal(consoleBoundaryResponse(new Request("http://127.0.0.1:5173/vacation"), hosts), null);
  assert.equal(consoleBoundaryResponse(new Request("https://console.example.test/console"), hosts), null);
});
