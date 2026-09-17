import { driverSummary } from "@/lib/campus-engine/driver-summary";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function GET(request: Request) {
  try {
    return ok(await driverSummary(request), undefined, request);
  } catch (error) {
    return fail(error, request);
  }
}
