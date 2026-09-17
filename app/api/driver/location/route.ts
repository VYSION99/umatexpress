import { updateDriverLocation } from "@/lib/campus-engine/driver";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function PATCH(request: Request) {
  try {
    return ok(await updateDriverLocation(request, await request.json()));
  } catch (error) {
    return fail(error);
  }
}

