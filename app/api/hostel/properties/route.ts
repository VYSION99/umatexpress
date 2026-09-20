import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listPublicProperties } from "@/lib/hostel-engine/listings";

const NO_STORE = { "Cache-Control": "no-store" };
const SORTS = ["distance", "price", "name"] as const;
type Sort = (typeof SORTS)[number];

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
    const result = await listPublicProperties({
      periodId: url.searchParams.get("periodId") || undefined,
      maxDistanceM: boundedParam(url.searchParams.get("maxDistance"), 50_000),
      maxPrice: boundedParam(url.searchParams.get("maxPrice"), 50_000_000),
      minSpaces: boundedParam(url.searchParams.get("minSpaces"), 60),
      utilitiesOnly: url.searchParams.get("utilities") === "1",
      sort: sortParam(url.searchParams.get("sort")),
    });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
