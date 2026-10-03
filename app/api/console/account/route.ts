import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { consoleAccountFromRequest, ensureConsoleAccountsTable } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { turso } from "@/lib/turso";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const account = await consoleAccountFromRequest(request);
  if (!account) return Response.json({ error: "Sign in to view your profile." }, { status: 401, headers: NO_STORE });
  return Response.json({ profile: { name: account.name, email: account.email, phone: account.phone, role: account.role, status: account.status } }, { headers: NO_STORE });
}

export async function PATCH(request: Request) {
  try {
    const account = await consoleAccountFromRequest(request);
    if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to edit your profile.", 401);
    const limited = await rateLimit(request, "console-account-profile", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const input = await request.json() as { name?: unknown; phone?: unknown };
    const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
    const phone = String(input.phone ?? "").trim();
    if (name.length < 2 || name.length > 80) throw new CampusEngineError("VALIDATION_ERROR", "Enter a display name between 2 and 80 characters.", 400);
    if (phone && (!/^[+0-9 ()-]{7,24}$/.test(phone) || phone.replace(/\D/g, "").length < 7)) throw new CampusEngineError("VALIDATION_ERROR", "Enter a valid contact number or leave it blank.", 400);
    await ensureConsoleAccountsTable();
    const changed = await turso("UPDATE console_accounts SET name=?,phone=?,updated_at=? WHERE id=? AND status='ACTIVE'", [name, phone, new Date().toISOString(), account.id]);
    if (Number(changed?.affected_row_count || 0) !== 1) throw new CampusEngineError("INVALID_STATE", "Your account is no longer active. Sign in again.", 409);
    await consoleAudit({ actor: account.email, action: "CONSOLE_PROFILE_UPDATED", targetType: "console_account", targetReference: account.id, details: { changed: ["name", "phone"] } }).catch(() => undefined);
    return Response.json({ profile: { name, email: account.email, phone, role: account.role, status: account.status } }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
