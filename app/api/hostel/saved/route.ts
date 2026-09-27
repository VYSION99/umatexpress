import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { listSavedHostels, removeSavedHostel, saveHostel, setHostelAlert } from "@/lib/hostel-engine/watchlist";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

function ids(body: Record<string, unknown>) {
  const propertyId = String(body.propertyId || "").trim();
  const periodId = String(body.periodId || "").trim();
  if (!propertyId || propertyId.length > 80 || !periodId || periodId.length > 80) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose a hostel and academic year.", 400);
  }
  return { propertyId, periodId };
}

async function respond(request: Request, action: "GET" | "POST" | "PATCH" | "DELETE") {
  try {
    const limit = await rateLimit(request, action === "GET" ? "hostel-saved-read" : "hostel-saved-write", { limit: action === "GET" ? 120 : 40, windowMs: 60_000 });
    if (!limit.ok) return rateLimitResponse(limit.retryAfter);
    const account = await requireStudent(request);
    if (action === "GET") return Response.json({ ok: true, saved: await listSavedHostels(account.email) }, { headers: NO_STORE });
    const body = await request.json() as Record<string, unknown>;
    const { propertyId, periodId } = ids(body);
    let saved;
    if (action === "POST") saved = await saveHostel(account.email, propertyId, periodId);
    else if (action === "PATCH") {
      if (typeof body.enabled !== "boolean") throw new CampusEngineError("VALIDATION_ERROR", "Choose whether alerts are on or off.", 400);
      saved = await setHostelAlert(account.email, propertyId, periodId, body.enabled);
    } else saved = await removeSavedHostel(account.email, propertyId, periodId);
    return Response.json({ ok: true, saved }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function GET(request: Request) { return respond(request, "GET"); }
export async function POST(request: Request) { return respond(request, "POST"); }
export async function PATCH(request: Request) { return respond(request, "PATCH"); }
export async function DELETE(request: Request) { return respond(request, "DELETE"); }
