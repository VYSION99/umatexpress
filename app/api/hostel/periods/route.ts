import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listHostelPeriods } from "@/lib/hostel-engine/periods";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The open academic years, for students and for the landlord's pricing form.
 * Only the fields a visitor needs: the review record and the internal ids the
 * platform uses to moderate stay on the console side.
 */
export async function GET() {
  try {
    const periods = await listHostelPeriods();
    return Response.json({
      ok: true,
      periods: periods.map((period) => ({ id: period.id, name: period.name, starts_on: period.startsOn, ends_on: period.endsOn })),
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
