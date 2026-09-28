import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole, type ConsoleAccount } from "@/lib/console-auth";
import { createAdminDelegate, listAdminDelegates, updateAdminDelegate } from "@/lib/console-delegates";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

async function requireOwner(request: Request): Promise<ConsoleAccount> {
  const account = await requireConsoleRole(request, ["ADMIN"]);
  if (account.delegateServices !== undefined) throw new CampusEngineError("FORBIDDEN", "Only the primary administrator can manage delegates.", 403);
  return account;
}

export async function GET(request: Request) {
  try {
    await requireOwner(request);
    return Response.json({ delegates: await listAdminDelegates() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireOwner(request);
    const limited = await rateLimit(request, "console-delegates-write", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { name?: unknown; email?: unknown; password?: unknown; services?: unknown };
    const delegate = await createAdminDelegate({ ...body, actor: account.email });
    return Response.json({ ok: true, delegate }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await requireOwner(request);
    const limited = await rateLimit(request, "console-delegates-write", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { id?: unknown; status?: unknown; services?: unknown };
    const delegate = await updateAdminDelegate({ ...body, actor: account.email, actorId: account.id });
    return Response.json({ ok: true, delegate }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
