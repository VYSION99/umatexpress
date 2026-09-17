import { openDriverRide, updateDriverRide } from "@/lib/campus-engine/driver";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function POST(request: Request) {
  try {
    return ok(await openDriverRide(request, await request.json()));
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return ok(await updateDriverRide(request, await request.json()));
  } catch (error) {
    return fail(error);
  }
}

