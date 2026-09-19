import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listStudentDisputes, openDispute } from "@/lib/disputes";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A passenger's own disputes. The account comes from the signed session, never
 * from the request, so one student cannot read or file against another.
 */
export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    return Response.json({ ok: true, disputes: await listStudentDisputes(student.email) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const student = await requireStudent(request);
    // A complaint is not something to send in bulk, and the record is the point
    // of the feature, so the limit is low enough to keep it meaningful.
    const limited = await rateLimit(request, "student-dispute", { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const dispute = await openDispute({
      raisedByRole: "STUDENT",
      raisedBy: student.email,
      // The reply address is the account's own: a contact field would let a
      // signed-in student point the reply somewhere the booking never touched.
      contact: student.email,
      bookingReference: body.bookingReference,
      category: body.category,
      subject: body.subject,
      details: body.details,
    });
    return Response.json({ ok: true, dispute }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
