import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listHostelListingsForStaff } from "@/lib/hostel-engine/listings";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The hostel review queue. `PENDING_REVIEW` is what needs a decision;
 * `APPROVED` is what is live and can be pulled if a complaint arrives.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const requested = (new URL(request.url).searchParams.get("status") || "PENDING_REVIEW").toUpperCase();
    const status = requested === "APPROVED" ? "APPROVED" : "PENDING_REVIEW";
    return Response.json({ ok: true, status, listings: await listHostelListingsForStaff(status) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
