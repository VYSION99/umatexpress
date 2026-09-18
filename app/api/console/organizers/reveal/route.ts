import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { revealOrganizerProfile } from "@/lib/organizers";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The only way to read a full payout or ID number back. Admin only, and every
 * call writes an audit row naming the actor and the fields opened — a reveal
 * that leaves no trace is the thing this endpoint exists to prevent.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { organizerId?: string };
    const organizerId = String(body.organizerId || "").trim();
    if (!organizerId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an organizer.", 400);
    const revealed = await revealOrganizerProfile(organizerId, account.email);
    return Response.json({ ok: true, revealed }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
