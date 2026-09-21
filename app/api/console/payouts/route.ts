import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { listPayoutOrganizers, organizerStatement, payoutAutoEnabled, payoutMinimumAmount, payoutTransferFee, platformPayoutBalance, recordPayoutBatch } from "@/lib/organizer-payouts";
import { getOrganizer, getOrganizerProfile } from "@/lib/organizers";
import { getPaymentProviderRuntime } from "@/lib/paystack";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The money console. Admin only: it shows what every organizer is owed, and
 * recording a payout is the one action here that moves real money — by hand,
 * outside the platform, with the transfer reference recorded afterwards.
 */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN"]);
    const organizerId = String(new URL(request.url).searchParams.get("organizerId") || "").trim();
    if (!organizerId) {
      // What the platform can actually pay with, and whether the unattended
      // job is allowed to spend it. Both are read-only here.
      const [organizers, balance, autoEnabled, provider, fee, minimum] = await Promise.all([
        listPayoutOrganizers(),
        platformPayoutBalance(),
        payoutAutoEnabled(),
        getPaymentProviderRuntime(),
        payoutTransferFee(),
        payoutMinimumAmount(),
      ]);
      return Response.json({
        organizers,
        automation: {
          enabled: autoEnabled,
          provider,
          transferFee: fee,
          minimum,
          balance: balance ? { currency: balance.currency, amount: balance.balance } : null,
        },
      }, { headers: NO_STORE });
    }

    const organizer = await getOrganizer(organizerId);
    if (!organizer) throw new CampusEngineError("NOT_FOUND", "That organizer was not found.", 404);
    // The profile read is masked, so the console can show the last four digits
    // of the payout account without opening it. A full read stays in the
    // audited reveal endpoint.
    const profile = await getOrganizerProfile(organizerId);
    return Response.json({
      organizer: {
        id: organizer.id,
        name: organizer.name,
        organization: organizer.organization,
        status: organizer.status,
        kycStatus: organizer.kycStatus,
        commissionBps: organizer.commissionBps,
        payoutMethod: profile?.payoutMethod || "",
        payoutAccountName: profile?.payoutAccountName || "",
        payoutAccountMasked: profile?.payoutAccountMasked || "",
        payoutBankName: profile?.payoutBankName || "",
        payoutBankCode: profile?.payoutBankCode || "",
        recipientReady: profile?.payoutRecipientReady || false,
      },
      statement: await organizerStatement(organizerId),
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    const body = await request.json() as { organizerId?: string; reference?: string; note?: string };
    const batch = await recordPayoutBatch({
      organizerId: String(body.organizerId || ""),
      reference: body.reference,
      note: body.note,
      actor: account.email,
    });
    return Response.json({ ok: true, batch }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
