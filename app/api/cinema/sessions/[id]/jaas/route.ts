import { fail, ok } from "@/lib/campus-engine/responses";
import { issueJaasStageAccess, releaseJaasStageAccess } from "@/lib/cinema-streaming/jaas";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store, private", Pragma: "no-cache" };

export async function POST(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-jaas-token", account.id, { limit: 20, windowMs: 5 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { deviceSessionId?: unknown };
    const access = await issueJaasStageAccess({
      sessionId: id,
      account,
      deviceSessionId: String(body.deviceSessionId || ""),
    });
    return ok({ access }, { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const account = await requireCinemaAccount(request);
    const { id } = await context.params;
    const body = await request.json() as { deviceSessionId?: unknown };
    return ok(await releaseJaasStageAccess({
      sessionId: id,
      accountId: account.id,
      deviceSessionId: String(body.deviceSessionId || ""),
    }), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}
