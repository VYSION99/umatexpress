import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { youTubeResults } from "@/lib/cinema-engine/youtube";
import { logEvent } from "@/lib/observability";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { envValue } from "@/lib/runtime-env";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };
/** A tray, not a results page: enough to pick from without a scroll. */
const RESULT_LIMIT = 8;
/** Below two letters every query matches everything; above 120 nothing does. */
const QUERY_MIN = 2;
const QUERY_MAX = 120;

/**
 * YouTube search for the lobby.
 *
 * A student types what they want to watch and the lobby asks YouTube through
 * this route, so the API key never reaches a browser and every query is rate
 * limited per caller, the way the platform treats every outbound spend. The
 * route answers with rows a room would accept — an eleven-character video id,
 * its title, its channel and a thumbnail from YouTube's own image host.
 *
 * With no key configured the route says so plainly and the lobby keeps its
 * paste-a-link path, which needs nothing but YouTube itself.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "cinema-youtube-search", { limit: 30, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    await requireStudent(request);
    const query = String(new URL(request.url).searchParams.get("q") || "").trim();
    if (query.length < QUERY_MIN) throw new CampusEngineError("VALIDATION_ERROR", "Type at least two letters to search.", 400);
    if (query.length > QUERY_MAX) throw new CampusEngineError("VALIDATION_ERROR", "That search is too long; try fewer words.", 400);
    const key = await envValue("YOUTUBE_API_KEY");
    if (!key) throw new CampusEngineError("CONFIG_REQUIRED", "Video search is not switched on for this deployment. Paste a YouTube link instead.", 503);

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("safeSearch", "strict");
    url.searchParams.set("maxResults", String(RESULT_LIMIT));
    url.searchParams.set("q", query);
    url.searchParams.set("key", key);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      // The query itself is not logged: it is a student's, not ours.
      logEvent("warn", "cinema_youtube_search_failed", { status: response.status });
      throw new CampusEngineError("ENGINE_ERROR", "YouTube would not answer that search. Try again, or paste a link.", 502);
    }
    const payload = await response.json().catch(() => null);
    return ok({ results: youTubeResults(payload) }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
