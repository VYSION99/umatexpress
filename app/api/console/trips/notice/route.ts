import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { getOrganizerNotice, saveOrganizerNotice } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

async function organizerIdFor(request: Request) {
  const account = await requireConsoleRole(request, ["ORGANIZER"]);
  if (!account.profileId) {
    throw new CampusEngineError("UNAUTHORIZED", "This account is not linked to an organizer profile.", 401);
  }
  return account.profileId;
}

/** The organizer's own notice; never another organizer's. */
export async function GET(request: Request) {
  try {
    return Response.json({ ok: true, notice: await getOrganizerNotice(await organizerIdFor(request)) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/** Partial updates merge onto the stored notice, so an omitted field keeps its value. */
export async function PUT(request: Request) {
  try {
    const organizerId = await organizerIdFor(request);
    const notice = await saveOrganizerNotice(organizerId, await request.json());
    return Response.json({ ok: true, notice }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
