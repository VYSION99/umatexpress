import { getCampusData } from "@/lib/campus-ride";
import { resolveCampusRouteSelection } from "@/lib/campus-zones";
import { withEdgeCache } from "@/lib/edge-cache";

export async function GET(request: Request) {
  return withEdgeCache(request, { path: "/api/campus/zones", maxAge: 60, staleWhileRevalidate: 600 }, async () => {
    const data = await getCampusData();
    const { zones, corridors } = resolveCampusRouteSelection(data);
    return Response.json({ zones, corridors });
  });
}
