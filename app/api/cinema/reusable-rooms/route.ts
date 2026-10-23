import { fail, ok } from "@/lib/campus-engine/responses";
import { listReusableCinemaRooms } from "@/lib/cinema-engine/reusable-rooms";
import { requireStudent } from "@/lib/student-auth";

export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    return ok({ rooms: await listReusableCinemaRooms(student.id) }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
