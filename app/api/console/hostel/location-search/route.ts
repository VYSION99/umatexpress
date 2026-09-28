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
    const key = await envValue("OPENROUTESERVICE_API_KEY");
    if (!key) return Response.json({ ok: true, suggestions: [], unavailable: true }, { headers: NO_STORE });
    const url = new URL("https://api.heigit.org/pelias/v1/search");
    url.searchParams.set("text", query);
    url.searchParams.set("size", "8");
    url.searchParams.set("focus.point.lat", "5.3");
    url.searchParams.set("focus.point.lon", "-2.0");
    try {
      const response = await fetch(url, { headers: { Authorization: key, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error("Geocoding unavailable");
      const data = await response.json() as { features?: Array<{ geometry?: { coordinates?: unknown }; properties?: { label?: string } }> };
      const suggestions = (data.features || []).flatMap((feature) => {
        const point = feature.geometry?.coordinates;
        const longitude = Array.isArray(point) ? Number(point[0]) : NaN;
        const latitude = Array.isArray(point) ? Number(point[1]) : NaN;
        const label = String(feature.properties?.label || "").slice(0, 160);
        return label && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= 5.0 && latitude <= 5.6 && longitude >= -2.4 && longitude <= -1.6 ? [{ label, latitude, longitude }] : [];
      });
      return Response.json({ ok: true, suggestions }, { headers: NO_STORE });
    } catch { return Response.json({ ok: true, suggestions: [], unavailable: true }, { headers: NO_STORE }); }
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: NO_STORE }); }
}
