import { campusOverview, manageCampusResource } from "@/lib/campus-engine/admin";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function GET(request: Request) {
  try {
    return ok(await campusOverview(request));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    return ok(await manageCampusResource(request));
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request) {
  return POST(request);
}
