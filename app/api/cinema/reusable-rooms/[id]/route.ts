import { fail, ok } from "@/lib/campus-engine/responses";
import { editReusableCinemaRoom, forgetReusableCinemaRoom } from "@/lib/cinema-engine/reusable-rooms";
import { requireStudent } from "@/lib/student-auth";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    await forgetReusableCinemaRoom(id, student.id);
    return ok({ removed: true }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    const body = await request.json() as { title?: unknown; visibility?: unknown };
    const room = await editReusableCinemaRoom({ id, hostStudentId: student.id, title: body.title, visibility: body.visibility });
    return ok({ room }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
