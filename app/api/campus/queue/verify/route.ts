import { verifyCampusRidePayment } from "@/lib/campus-engine/rides";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function GET(request: Request) {
  try {
    const reference = new URL(request.url).searchParams.get("reference") || "";
    return ok(await verifyCampusRidePayment(request, reference), { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
