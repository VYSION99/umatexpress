const CACHE_NAME = "umatexpress-shell-v6";
// Staff surfaces live on the console origin and are never precached here: a
// cross-origin redirect is not a cacheable shell response.
const APP_SHELL = [
  "/",
  "/campus",
  "/vacation",
  "/logo-mark.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/acmd-logo.png",
  "/clipad-mark.svg",
  "/vip-coach.png",
  "/manifest.webmanifest"
];

// Navigations must revalidate. A cached HTML document can reference hashed build
// assets that were removed by the next deploy, which breaks the app until the user
// clears site data. Static assets are immutable per build, so they are safe to
// serve stale while the fresh copy is fetched in the background.
const CACHEABLE_ASSETS = new Set(["style", "script", "font", "image"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (CACHEABLE_ASSETS.has(request.destination)) event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    // Offline: fall back to this exact page, then to the cached home shell.
    return (await cache.match(request)) || (await cache.match("/")) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await fresh) || Response.error();
}
