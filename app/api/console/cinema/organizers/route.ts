import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { decideCinemaOrganizer, listPendingCinemaOrganizers } from "@/lib/cinema-engine/events";
import { requireConsoleRole } from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    return Response.json({ organizers: await listPendingCinemaOrganizers() }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.id !== "string" || typeof body.approve !== "boolean") return Response.json({ error: "Choose a request and a decision." }, { status: 400, headers });
    const organizer = await decideCinemaOrganizer({ id: body.id, approve: body.approve, actor: actor.email, verificationNote: body.verificationNote });
    await consoleAudit({ actor: actor.email, action: body.approve ? "CINEMA_ORGANIZER_APPROVED" : "CINEMA_ORGANIZER_REJECTED", targetType: "cinema_organizer", targetReference: body.id });
    return Response.json({ organizer }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
