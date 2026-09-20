type EdgeCacheStore = {
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
};

/**
 * Cloudflare's per-colo cache. Absent in Node (tests, local SSR) and in local
 * `wrangler dev` runs, so every caller must treat caching as advisory.
 */
function edgeCache(): EdgeCacheStore | null {
  const store = (globalThis as { caches?: { default?: EdgeCacheStore } }).caches;
  return store?.default ?? null;
}

function cacheKeyFor(request: Request, path: string) {
  return new Request(new URL(path, request.url).toString(), { method: "GET" });
}

/**
 * Serves a public GET from the edge cache when possible. Responses are only
 * stored when the producer succeeds, so a Turso failure is never cached.
 */
export async function withEdgeCache(
  request: Request,
  options: { path: string; maxAge: number; staleWhileRevalidate?: number },
  produce: () => Promise<Response>,
) {
  const cacheControl = `public, max-age=${options.maxAge}, s-maxage=${options.maxAge}`
    + (options.staleWhileRevalidate ? `, stale-while-revalidate=${options.staleWhileRevalidate}` : "");
  const cache = edgeCache();
  // Never serve cached data to a mutation or a non-GET probe.
  if (!cache || request.method !== "GET") {
    const response = await produce();
    response.headers.set("Cache-Control", cacheControl);
    return response;
  }

  const key = cacheKeyFor(request, options.path);
  // A cache lookup is advisory: if the edge cache is unhappy, the producer
  // still answers rather than the whole request failing with it.
  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch {
    hit = undefined;
  }
  if (hit) return hit;

  const response = await produce();
  if (!response.ok) return response;

  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);
  const cached = new Response(body, { status: response.status, statusText: response.statusText, headers });
  try {
    await cache.put(key, cached.clone());
  } catch {
    // A cache write must never fail the request.
  }
  return cached;
}
