import { fail, ok } from "@/lib/campus-engine/responses";
import { forgetReusableCinemaRoom } from "@/lib/cinema-engine/reusable-rooms";
import { requireStudent } from "@/lib/student-auth";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    await forgetReusableCinemaRoom(id, student.id);
    return ok({ removed: true }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
