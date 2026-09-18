import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listOrganizers, setOrganizerStatus } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };
const REVIEW_ACTIONS = ["APPROVE", "REJECT", "SUSPEND"] as const;

/** The application queue. Admins and moderators may both decide. */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const status = new URL(request.url).searchParams.get("status") || "";
    return Response.json({ organizers: await listOrganizers({ status }) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as { organizerId?: string; action?: string; reason?: string };
    const action = String(body.action || "").trim().toUpperCase();
    if (!(REVIEW_ACTIONS as readonly string[]).includes(action)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose approve, reject or suspend.", 400);
    }
    const organizerId = String(body.organizerId || "").trim();
    if (!organizerId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an application to review.", 400);

    const organizer = await setOrganizerStatus({
      organizerId,
      action: action as (typeof REVIEW_ACTIONS)[number],
      reason: body.reason,
      actor: account.email,
    });
    return Response.json({ ok: true, organizer }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
