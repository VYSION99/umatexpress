import { driverQueue, updateDriverQueueEntry } from "@/lib/campus-engine/driver";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function GET(request: Request) {
  try {
    return ok(await driverQueue(request));
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return ok(await updateDriverQueueEntry(request, await request.json()));
  } catch (error) {
    return fail(error);
  }
}
