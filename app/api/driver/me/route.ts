import { driverMe } from "@/lib/campus-engine/driver";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function GET(request: Request) {
  try {
    return ok(await driverMe(request));
  } catch (error) {
    return fail(error);
  }
}

