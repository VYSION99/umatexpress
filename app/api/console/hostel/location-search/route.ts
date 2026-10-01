import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { envValue } from "@/lib/runtime-env";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
const NO_STORE = { "Cache-Control": "no-store" };
/** Suggestions only. The owner must confirm the address and pin before saving. */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-location-search", { limit: 30, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const query = String(new URL(request.url).searchParams.get("q") || "").trim().slice(0, 100);
    if (query.length < 3) return Response.json({ ok: true, suggestions: [] }, { headers: NO_STORE });
    const key = await envValue("HERE_API_KEY");
    if (!key) return Response.json({ ok: true, suggestions: [], unavailable: true }, { headers: NO_STORE });
    const url = new URL("https://autosuggest.search.hereapi.com/v1/autosuggest");
    url.searchParams.set("q", query);
    url.searchParams.set("at", "5.3,-2.0");
    url.searchParams.set("limit", "8");
    url.searchParams.set("apiKey", key);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error("Geocoding unavailable");
      const data = await response.json() as { items?: Array<{ title?: string; address?: { label?: string }; position?: { lat?: number; lng?: number } }> };
      const suggestions = (data.items || []).flatMap((item) => {
        const latitude = Number(item.position?.lat);
        const longitude = Number(item.position?.lng);
        const label = String(item.address?.label || item.title || "").slice(0, 160);
        return label && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= 5.0 && latitude <= 5.6 && longitude >= -2.4 && longitude <= -1.6 ? [{ label, latitude, longitude }] : [];
      });
      return Response.json({ ok: true, suggestions }, { headers: NO_STORE });
    } catch { return Response.json({ ok: true, suggestions: [], unavailable: true }, { headers: NO_STORE }); }
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
