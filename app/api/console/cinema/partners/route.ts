import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { decideCinemaPartner, listCinemaPartners, cinemaPartnerForAccount } from "@/lib/cinema-engine/partners";
import { requireConsoleRole } from "@/lib/console-auth";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const actor = await requireConsoleRole(request, ["ADMIN", "MODERATOR", "CINEMA"]);
    if (actor.role === "CINEMA") {
      const partner = await cinemaPartnerForAccount(actor.id);
      return Response.json({ partner }, { headers });
    }
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "ALL";
    const partners = await listCinemaPartners(status);
    return Response.json({ partners }, { headers });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers });
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const body = await request.json() as Record<string, unknown>;
    const partnerId = String(body.partnerId || body.id || "").trim();
    const approve = Boolean(body.approve);
    const reviewNote = typeof body.reviewNote === "string" ? body.reviewNote : typeof body.verificationNote === "string" ? body.verificationNote : "";
    const result = await decideCinemaPartner({
      partnerId,
      approve,
      actor: actor.email,
      reviewNote,
    });
    return Response.json(result, { headers });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers });
  }
}
