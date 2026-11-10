import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { CINEMA_ROOM_PLANS, ensureCinemaRoomPlans, isCinemaRoomPlan } from "@/lib/cinema-engine/room-plans";
import { requireConsoleRole } from "@/lib/console-auth";
import { consoleAudit } from "@/lib/console-audit";
import { validStudentEmail } from "@/lib/student-email";
import { rowsToObjects, turso } from "@/lib/turso";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    await ensureCinemaRoomPlans();
    const grants = rowsToObjects(await turso("SELECT g.account_id,COALESCE(a.email,'') AS email,g.plan,g.valid_until,g.granted_by,g.reason,g.updated_at FROM cinema_room_plan_grants g LEFT JOIN student_accounts a ON a.id = g.account_id ORDER BY g.updated_at DESC LIMIT 100"));
    const prices = rowsToObjects(await turso("SELECT plan,price_pesewas,enabled,updated_at FROM cinema_room_plan_prices ORDER BY plan"));
    return Response.json({ plans: CINEMA_ROOM_PLANS, grants, prices }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireConsoleRole(request, ["ADMIN"]);
    await ensureCinemaRoomPlans();
    const body = await request.json() as { accountId?: unknown; email?: unknown; plan?: unknown; validUntil?: unknown; reason?: unknown; pricePlan?: unknown; pricePesewas?: unknown; enabled?: unknown; politicsApproval?: unknown };
    if (body.pricePlan !== undefined) {
      const pricePlan = String(body.pricePlan || "");
      const price = Number(body.pricePesewas);
      if (!isCinemaRoomPlan(pricePlan) || pricePlan === "FREE" || !Number.isSafeInteger(price) || price < 100 || price > 1_000_000 || typeof body.enabled !== "boolean") {
        throw new CampusEngineError("VALIDATION_ERROR", "Set a paid plan price between GH₵1 and GH₵10,000 and choose whether checkout is open.", 400);
      }
      await turso("UPDATE cinema_room_plan_prices SET price_pesewas=?,enabled=?,updated_by=?,updated_at=? WHERE plan=?", [price, body.enabled ? 1 : 0, actor.email, new Date().toISOString(), pricePlan]);
      await consoleAudit({ actor: actor.email, action: "CINEMA_ROOM_PLAN_PRICE_UPDATED", targetType: "cinema_room_plan", targetReference: pricePlan, details: { pricePesewas: price, enabled: body.enabled } });
      return Response.json({ plan: pricePlan, pricePesewas: price, enabled: body.enabled }, { headers });
    }
    const suppliedAccountId = String(body.accountId || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const plan = String(body.plan || "").trim();
    const approval = body.politicsApproval;
    if (approval !== undefined && approval !== "APPROVE" && approval !== "REVOKE") throw new CampusEngineError("VALIDATION_ERROR", "Choose whether to approve or revoke Student Politics Plus checkout.", 400);
    const validUntil = approval === "REVOKE" ? "" : String(body.validUntil || "").trim();
    const reason = String(body.reason || "").trim().slice(0, 240);
    if ((!suppliedAccountId && !email) || (!approval && !isCinemaRoomPlan(plan)) || !reason || (validUntil && (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now()))) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose an account, record an authorization reason, and use a future expiry if applicable. Select a plan for manual grants.", 400);
    }
    const account = rowsToObjects(await turso(suppliedAccountId
      ? "SELECT id,email FROM student_accounts WHERE id = ? LIMIT 1"
      : "SELECT id,email FROM student_accounts WHERE lower(email) = ? LIMIT 1", [suppliedAccountId || email]))[0];
    if (!account) throw new CampusEngineError("NOT_FOUND", "Account not found.", 404);
    const accountId = String(account.id);
    if (approval) {
      if (approval === "APPROVE" && !validStudentEmail(String(account.email || ""))) throw new CampusEngineError("VALIDATION_ERROR", "Student Politics Plus checkout requires a UMaT student account.", 400);
      if (approval === "APPROVE") {
        await turso(`INSERT INTO cinema_room_plan_politics_approvals(account_id,valid_until) VALUES (?,?)
          ON CONFLICT(account_id) DO UPDATE SET valid_until=excluded.valid_until`, [accountId, validUntil ? new Date(validUntil).toISOString() : ""]);
      } else {
        await turso("DELETE FROM cinema_room_plan_politics_approvals WHERE account_id=?", [accountId]);
      }
      await consoleAudit({ actor: actor.email, action: "CINEMA_POLITICS_PLAN_CHECKOUT_APPROVAL", targetType: "student_account", targetReference: accountId, details: { approval, validUntil, reason } });
      return Response.json({ accountId, approval }, { headers });
    }
    await turso(
      "INSERT INTO cinema_room_plan_grants (account_id,plan,valid_until,granted_by,reason,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan,valid_until=excluded.valid_until,granted_by=excluded.granted_by,reason=excluded.reason,updated_at=excluded.updated_at",
      [accountId, plan, validUntil, actor.email, reason, new Date().toISOString()],
    );
    await consoleAudit({ actor: actor.email, action: "CINEMA_ROOM_PLAN_GRANTED", targetType: "student_account", targetReference: accountId, details: { plan, validUntil, reason } });
    return Response.json({ accountId, plan, validUntil }, { headers });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers }); }
}
