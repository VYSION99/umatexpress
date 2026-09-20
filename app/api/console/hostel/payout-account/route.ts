import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assertHostelOwner, resolveHostelHost } from "@/lib/hostel-engine/managers";
import { getHostelPayoutAccount, revealHostelPayoutAccount, saveHostelPayoutAccount } from "@/lib/hostel-engine/payouts";
import { listPayoutDestinations } from "@/lib/paystack-banks";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Where a landlord's money should go.
 *
 * The landlord reads the masked account and substitutes it; an administrator
 * may reveal the full number, and that reveal is audited. A delegate manager
 * can see the masked row but cannot change it: a manager runs the building, the
 * owner owns the money.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD", "ADMIN"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);

    if (account.role === "ADMIN") {
      const landlordId = String(url.searchParams.get("landlordId") || "").trim();
      if (!landlordId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a landlord.", 400);
      if (url.searchParams.get("reveal") === "1") {
        const revealed = await revealHostelPayoutAccount(landlordId, account.email);
        return Response.json({ ok: true, landlordId, ...revealed }, { headers: NO_STORE });
      }
      return Response.json({ ok: true, landlordId, account: await getHostelPayoutAccount(landlordId) }, { headers: NO_STORE });
    }

    const host = await resolveHostelHost(account);
    // The form has to offer somewhere to send the money, so the banks and
    // networks come back with the account rather than from a second call.
    const [saved, banks, networks] = await Promise.all([
      getHostelPayoutAccount(host.landlordId),
      listPayoutDestinations("BANK"),
      listPayoutDestinations("MOMO"),
    ]);
    return Response.json({ ok: true, isOwner: host.isOwner, account: saved, destinations: { BANK: banks, MOMO: networks } }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-payout-account", { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = assertHostelOwner(await resolveHostelHost(account));
    const body = await request.json() as { method?: unknown; accountName?: unknown; accountNumber?: unknown; bankCode?: unknown };
    const saved = await saveHostelPayoutAccount({
      landlordId: host.landlordId,
      method: body.method,
      accountName: body.accountName,
      accountNumber: body.accountNumber,
      bankCode: body.bankCode,
      actor: account.email,
    });
    return Response.json({ ok: true, account: saved }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
