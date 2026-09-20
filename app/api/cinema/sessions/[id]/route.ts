import { fail, ok } from "@/lib/campus-engine/responses";
import { patchRoom, readRoom } from "@/lib/cinema-engine/rooms";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One room, read or changed.
 *
 * A room that has ended still resolves, because the page has something to say
 * about it; a room that is closed or deleted answers 404, so an id cannot be
 * probed for existence. Changes are host-only and are refused by the engine, not
 * merely hidden from the client.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    return ok({ room }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const { id } = await context.params;
    const body = await request.json() as { action?: string; title?: string };
    const room = await patchRoom({ id, studentId: student.id, action: body.action, title: body.title });
    return ok({ room }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
