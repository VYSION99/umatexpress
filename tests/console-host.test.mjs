import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const {
  LEGACY_CONSOLE_PATHS,
  parseConsoleHosts,
  isConsoleNativePath,
  isConsoleSurfacePath,
  isFrameworkAssetPath,
  isLoopbackHost,
  legacyConsoleRedirect,
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
  for (const path of ["/console", "/console/campus", "/console/vacation", "/console/driver", "/console/change-password", "/api/console/session", "/admin/reset-password", "/api/admin/bookings", "/api/driver/me", "/api/trips/schedule", "/api/campus/ai"]) {
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
  for (const path of ["/", "/vacation", "/api/trips/schedule", "/api/payments/webhook"]) {
    assert.deepEqual(consoleHostAction(PUBLIC, path, CONSOLE), { action: "serve" }, `${path} must keep working publicly`);
  }
});

test("an address the console used to answer on now redirects to it", () => {
  const expected = {
    "/admin": "/console",
    "/admin/login": "/console/login",
    "/admin/change-password": "/console/change-password",
    "/admin/campus": "/console/campus",
    "/admin/vacation": "/console/vacation",
    "/driver": "/console/driver",
    "/driver/login": "/console/login",
  };
  assert.deepEqual(LEGACY_CONSOLE_PATHS, expected);
  // On the console origin the console is a sibling path, so the redirect is relative.
  for (const [legacy, target] of Object.entries(expected)) {
    assert.equal(legacyConsoleRedirect("console.umatexpress.com", legacy, CONSOLE), target);
    assert.deepEqual(consoleHostAction("console.umatexpress.com", legacy, CONSOLE), { action: "legacy", location: target });
    // Everywhere else the browser is sent to the origin that answers for it.
    assert.deepEqual(consoleHostAction(PUBLIC, legacy, CONSOLE), { action: "legacy", location: `https://console.umatexpress.com${target}` });
  }
  // Local development keeps both on one origin, and an unconfigured deployment
  // has no console origin to name, so neither is sent off-host.
  assert.equal(legacyConsoleRedirect("127.0.0.1:5190", "/admin/campus", CONSOLE), "/console/campus");
  assert.equal(legacyConsoleRedirect(PUBLIC, "/driver", []), "/console/driver");
  // Anything that is not a legacy console path is left alone.
  assert.equal(legacyConsoleRedirect(PUBLIC, "/admin/reset-password", CONSOLE), null);
  assert.equal(legacyConsoleRedirect(PUBLIC, "/vacation", CONSOLE), null);
});

test("local development and an unconfigured deployment are not locked out", () => {
  assert.deepEqual(consoleHostAction("127.0.0.1:5190", "/console", []), { action: "serve" });
  assert.deepEqual(consoleHostAction("localhost:5190", "/api/console/session", CONSOLE), { action: "serve" });
  // Local development stays boundary-free even when the console host is set,
  // otherwise /vacation and /campus would 404 on the developer's machine.
  assert.deepEqual(consoleHostAction("127.0.0.1", "/", CONSOLE), { action: "serve" });
  assert.deepEqual(consoleHostAction("localhost:5190", "/vacation", CONSOLE), { action: "serve" });
  // A legacy console path still redirects locally, because the console is served there too.
  assert.deepEqual(consoleHostAction("localhost:5190", "/admin", CONSOLE), { action: "legacy", location: "/console" });
  // Before the boundary is configured every host keeps working, including the console paths.
  assert.deepEqual(consoleHostAction(PUBLIC, "/console", []), { action: "serve" });
});

test("static assets are allowed on the console and the service worker is not", () => {
  for (const path of ["/assets/main.js", "/favicon.svg", "/logo-web.png", "/manifest.webmanifest", "/.well-known/security.txt"]) {
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

  // A legacy address redirects to the console and keeps whatever query it carried.
  const legacy = consoleBoundaryResponse(new Request("https://umatexpress.example.test/driver?ref=abc"), hosts);
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get("location"), "https://console.example.test/console/driver?ref=abc");

  // Unconfigured and loopback requests continue to the app untouched.
  assert.equal(consoleBoundaryResponse(new Request("https://umatexpress.example.test/api/console/session"), ""), null);
  assert.equal(consoleBoundaryResponse(new Request("http://127.0.0.1:5173/vacation"), hosts), null);
  assert.equal(consoleBoundaryResponse(new Request("https://console.example.test/console"), hosts), null);
});
