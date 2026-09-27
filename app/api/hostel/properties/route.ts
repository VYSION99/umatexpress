import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listPublicProperties } from "@/lib/hostel-engine/listings";
import { withEdgeCache } from "@/lib/edge-cache";
import { logEvent } from "@/lib/observability";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { withTransientRetry } from "@/lib/transient";

const NO_STORE = { "Cache-Control": "no-store" };
const SORTS = ["distance", "price", "name"] as const;
type Sort = (typeof SORTS)[number];

/** Availability changes on holds and payments; keep browse snapshots short-lived. */
const CACHE_SECONDS = 15;
const CACHE_SWR_SECONDS = 0;
/** A campus network puts hundreds of students behind one address. */
const READ_LIMIT = 240;

/**
 * A filter a browse page may ignore: junk or out-of-range values fall back to
 * "no filter" so a mistyped URL still shows the catalogue instead of an error.
 */
function boundedParam(value: string | null, max: number) {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return undefined;
  return Math.round(parsed);
}

function sortParam(value: string | null): Sort {
  const candidate = String(value || "").trim() as Sort;
  return SORTS.includes(candidate) ? candidate : "name";
}

/**
 * The buildings behind the student map: one row per property that has at least
 * one approved bed in the open year, with its pin, its cheapest bed and how many
 * beds are free. Browsing needs no account, so the response carries nothing
 * about the landlord and nothing unpublished.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limited = await rateLimit(request, "hostel-properties-read", { limit: READ_LIMIT, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    // The query string is part of the key: a filtered search must never be
    // served the unfiltered catalogue.
    return await withEdgeCache(request, { path: `/api/hostel/properties${url.search}`, maxAge: CACHE_SECONDS, staleWhileRevalidate: CACHE_SWR_SECONDS }, async () => {
      const result = await withTransientRetry(
        () => listPublicProperties({
          q: (url.searchParams.get("q") || "").slice(0, 100),
          page: boundedParam(url.searchParams.get("page"), 100000),
          pageSize: boundedParam(url.searchParams.get("pageSize"), 48),
          periodId: url.searchParams.get("periodId") || undefined,
          propertyIds: (url.searchParams.get("ids") || "").split(",").map(value => value.trim()).filter(value => value.length > 0 && value.length <= 80).slice(0, 4),
          maxDistanceM: boundedParam(url.searchParams.get("maxDistance"), 50_000),
          maxPrice: boundedParam(url.searchParams.get("maxPrice"), 50_000_000),
          minSpaces: boundedParam(url.searchParams.get("minSpaces"), 60),
          utilitiesOnly: url.searchParams.get("utilities") === "1",
          sort: sortParam(url.searchParams.get("sort")),
        }),
        { label: "hostel_properties" },
      );
      return Response.json({ ok: true, ...result }, { headers: NO_STORE });
    });
  } catch (error) {
    // The only public catalogue read: if it ever fails for real, the reason
    // should be visible in `wrangler tail` rather than guessed at.
    logEvent("error", "hostel_properties_read_failed", { reason: error instanceof Error ? error.message : "unknown" });
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
