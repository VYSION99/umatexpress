import { campusOverview } from "@/lib/campus-engine/admin";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function GET(request: Request) {
  try {
    return ok(await campusOverview(request));
  } catch (error) {
    return fail(error);
  }
}
