import { campusRoadRoute } from "@/lib/campus-routing";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";

function numberParam(url: URL, name: string) {
  const value = Number(url.searchParams.get(name));
  if (!Number.isFinite(value)) throw new CampusEngineError("VALIDATION_ERROR", `Missing ${name}.`, 400);
  return value;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const route = await campusRoadRoute(
      { latitude: numberParam(url, "fromLat"), longitude: numberParam(url, "fromLng") },
      { latitude: numberParam(url, "toLat"), longitude: numberParam(url, "toLng") },
    );
    return ok(route);
  } catch (error) {
    return fail(error);
  }
}
