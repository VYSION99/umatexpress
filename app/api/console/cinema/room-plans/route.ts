import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { CINEMA_ROOM_PLANS, ensureCinemaRoomPlans } from "@/lib/cinema-engine/room-plans";
import { requireConsoleRole } from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";
import { rowsToObjects, turso } from "@/lib/turso";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    await ensureCinemaRoomPlans();
    const grants = rowsToObjects(await turso("SELECT g.account_id,COALESCE(a.email,'') AS email,g.plan,g.valid_until,g.granted_by,g.reason,g.updated_at FROM cinema_room_plan_grants g LEFT JOIN student_accounts a ON a.id = g.account_id ORDER BY g.updated_at DESC LIMIT 100"));
    return Response.json({ plans: CINEMA_ROOM_PLANS, grants }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireConsoleRole(request, ["ADMIN"]);
    await ensureCinemaRoomPlans();
    const body = await request.json() as { accountId?: unknown; email?: unknown; plan?: unknown; validUntil?: unknown; reason?: unknown };
    const suppliedAccountId = String(body.accountId || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const plan = String(body.plan || "").trim();
    const validUntil = String(body.validUntil || "").trim();
    const reason = String(body.reason || "").trim().slice(0, 240);
    if ((!suppliedAccountId && !email) || !(plan in CINEMA_ROOM_PLANS) || !reason || (validUntil && (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now()))) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose an account and plan, record an authorization reason, and use a future expiry if applicable.", 400);
    }
    const account = rowsToObjects(await turso(suppliedAccountId
      ? "SELECT id FROM student_accounts WHERE id = ? LIMIT 1"
      : "SELECT id FROM student_accounts WHERE lower(email) = ? LIMIT 1", [suppliedAccountId || email]))[0];
    if (!account) throw new CampusEngineError("NOT_FOUND", "Account not found.", 404);
    const accountId = String(account.id);
    await turso(
      "INSERT INTO cinema_room_plan_grants (account_id,plan,valid_until,granted_by,reason,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan,valid_until=excluded.valid_until,granted_by=excluded.granted_by,reason=excluded.reason,updated_at=excluded.updated_at",
      [accountId, plan, validUntil, actor.email, reason, new Date().toISOString()],
    );
    await consoleAudit({ actor: actor.email, action: "CINEMA_ROOM_PLAN_GRANTED", targetType: "student_account", targetReference: accountId, details: { plan, validUntil, reason } });
    return Response.json({ accountId, plan, validUntil }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
