/**
 * The console lives on its own origin and owns its own paths. This module is
 * the single description of that boundary, and it is deliberately free of
 * runtime imports so the Worker entry, the app and the tests can all share it.
 *
 * The host split is defence in depth. The control that actually protects the
 * console is that every console route requires a signed session; the host rules
 * exist so a console page can never be served as part of the public site.
 */

export const CONSOLE_ENTRY_PATH = "/console";
export const CONSOLE_SIGN_IN_PATH = "/console/login";

/** Console-native paths: console only, never served on the public host. */
const CONSOLE_NATIVE_PATHS = ["/console", "/api/console"];

/**
 * The console origin serves the console itself and the APIs its pages call.
 * The old /admin and /driver pages are gone: their paths redirect to the
 * console (see LEGACY_CONSOLE_PATHS). The one legacy page still standing is
 * the administrator password reset, which the console does not replace yet.
 */
const CONSOLE_SURFACE_PREFIXES = [
  "/console",
  "/api/console",
  "/admin",
  "/api/admin",
  "/api/driver",
  // Only the two admin trip endpoints: the public trip reads stay public, so a
  // future /api/trips/* route never becomes reachable from the console by
  // accident.
  "/api/trips/display",
  "/api/trips/schedule",
];

/** Shared helpers the console screens already call. */
const CONSOLE_SURFACE_EXACT = new Set(["/api/campus/ai"]);

/**
 * Static output and framework internals. Asset requests normally never reach
 * the Worker (Cloudflare serves the asset directory first), but local dev and
 * preview paths do, and a console page without its CSS is not a page.
 */
const ASSET_PREFIXES = ["/assets", "/_next", "/_vinext", "/.well-known"];
const ASSET_FILES = new Set([
  "/favicon.ico", "/favicon.svg", "/logo.png", "/logo-web.png", "/logo-mark.png",
  "/icon-192.png", "/icon-512.png", "/vip-coach.png",
  "/manifest.webmanifest", "/robots.txt",
]);

/** The public shell service worker must never be registered on the console. */
export const CONSOLE_BLOCKED_ASSET_FILES = new Set(["/sw.js"]);

export function parseConsoleHosts(value: unknown): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(",")
    .map((host) => host.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

export function isLoopbackHost(host: string) {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return name === "localhost"
    || name === "127.0.0.1"
    || name === "::1"
    || name === "[::1]"
    || name.endsWith(".localhost");
}

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where each legacy console path now lives. The console is one console, and
 * these are the addresses it used to answer on: a bookmark, a shared link or a
 * driver's saved home screen must land on the surface, not on a 404.
 */
export const LEGACY_CONSOLE_PATHS: Readonly<Record<string, string>> = {
  "/admin": "/console",
  "/admin/login": "/console/login",
  "/admin/change-password": "/console/change-password",
  "/admin/campus": "/console/campus",
  "/admin/vacation": "/console/vacation",
  "/driver": "/console/driver",
  "/driver/login": "/console/login",
};

/**
 * The redirect for a legacy path, or null when the path still stands on its
 * own. On the console origin — and anywhere the boundary is not in force, such
 * as local development — the console is a sibling path, so the redirect stays
 * relative. On any other host the browser is sent to the console origin, which
 * is the only origin that answers for it.
 */
export function legacyConsoleRedirect(host: string, pathname: string, hosts: readonly string[]): string | null {
  const target = LEGACY_CONSOLE_PATHS[pathname];
  if (!target) return null;
  const configured = hosts.map((item) => item.toLowerCase());
  if (!configured.length || isLoopbackHost(host) || configured.includes(host.toLowerCase())) return target;
  return `https://${configured[0]}${target}`;
}

/** Console-native paths are refused on every host that is not the console. */
export function isConsoleNativePath(pathname: string) {
  return CONSOLE_NATIVE_PATHS.some((prefix) => matchesPrefix(pathname, prefix));
}

/** Paths the console origin is allowed to serve while it hosts real work. */
export function isConsoleSurfacePath(pathname: string) {
  if (isConsoleNativePath(pathname)) return true;
  if (CONSOLE_SURFACE_EXACT.has(pathname)) return true;
  return CONSOLE_SURFACE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export function isFrameworkAssetPath(pathname: string) {
  if (CONSOLE_BLOCKED_ASSET_FILES.has(pathname)) return false;
  if (ASSET_FILES.has(pathname)) return true;
  return ASSET_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export type ConsoleHostAction =
  | { action: "serve" }
  | { action: "redirect"; location: string }
  | { action: "legacy"; location: string }
  | { action: "not-found" };

/**
 * Decides how one request should be handled, given the configured console
 * hosts. With no hosts configured the boundary is inactive: local development
 * and the current workers.dev deployment keep working, and the session guard is
 * still the thing standing in front of every console route.
 */
export function consoleHostAction(host: string, pathname: string, hosts: readonly string[]): ConsoleHostAction {
  const configured = hosts.map((item) => item.toLowerCase());
  // An address the console used to answer on is answered for on every host,
  // before any boundary decision, so it keeps working wherever it is opened.
  const legacy = legacyConsoleRedirect(host, pathname, configured);
  if (legacy) return { action: "legacy", location: legacy };

  // Unconfigured deployments and local development are boundary-free: every
  // path keeps working, and the session guard is what protects the console.
  if (!configured.length || isLoopbackHost(host)) return { action: "serve" };

  const onConsoleHost = configured.includes(host.toLowerCase());
  if (onConsoleHost) {
    if (pathname === "/") return { action: "redirect", location: CONSOLE_ENTRY_PATH };
    if (isConsoleSurfacePath(pathname)) return { action: "serve" };
    if (isFrameworkAssetPath(pathname)) return { action: "serve" };
    return { action: "not-found" };
  }

  return isConsoleNativePath(pathname) ? { action: "not-found" } : { action: "serve" };
}

/**
 * The whole host decision, response included, so the Worker entry stays a single
 * call and this behaviour is covered by tests that do not need a live runtime.
 * Returns null when the request should continue to the app.
 */
export function consoleBoundaryResponse(request: Request, configuredHosts: unknown): Response | null {
  const url = new URL(request.url);
  const decision = consoleHostAction(url.host, url.pathname, parseConsoleHosts(configuredHosts));
  if (decision.action === "legacy") {
    // A legacy address can carry a query string (a filter, a shared link); the
    // redirect keeps it instead of dropping it on the way to the console.
    const location = new URL(decision.location, request.url);
    location.search = url.search;
    return Response.redirect(location.toString(), 302);
  }
  if (decision.action === "redirect") return Response.redirect(new URL(decision.location, request.url).toString(), 302);
  if (decision.action === "not-found") return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return null;
}
