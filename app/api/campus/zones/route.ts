import { getCampusData } from "@/lib/campus-ride";
import { withEdgeCache } from "@/lib/edge-cache";

export async function GET(request: Request) {
  return withEdgeCache(request, { path: "/api/campus/zones", maxAge: 60, staleWhileRevalidate: 600 }, async () => {
    const data = await getCampusData();
    return Response.json({ zones: data.zones, corridors: data.corridors });
  });
}
