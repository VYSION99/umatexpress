import { requireSuperAdmin } from "@/lib/campus-engine/admin";
import { reconcilePendingCampusPayments } from "@/lib/campus-engine/reconcile";
import { fail, ok } from "@/lib/campus-engine/responses";

export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    return ok(await reconcilePendingCampusPayments(), undefined, request);
  } catch (error) {
    return fail(error, request);
  }
}

export const GET = POST;
