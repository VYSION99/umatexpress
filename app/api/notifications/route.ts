import { listNotifications, markNotificationsRead, unreadNotificationCount } from "@/lib/notifications";
import { studentAccountFromRequest } from "@/lib/student-auth";
import { studentEmailClaim } from "@/lib/student-email-claims";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertSameOrigin, fail, ok } from "@/lib/campus-engine/responses";

/**
 * Resolves all addresses that belong to the verified account (primary + linked student email).
 */
async function accountRecipients(account: { id: string; email: string; emailVerified: boolean }) {
  const recipients = [account.email];
  try {
    const claim = await studentEmailClaim(account.id);
    if (claim.verified && claim.studentEmail && !recipients.includes(claim.studentEmail)) {
      recipients.push(claim.studentEmail);
    }
  } catch {
    // Fallback cleanly to primary email if claims lookup cannot run
  }
  return recipients;
}

/**
 * The signed-in account's in-app notification feed.
 *
 * Supports both primary accounts and verified linked student emails.
 *
 *   GET   the latest messages for the account
 *   PATCH mark one message, or the whole feed, as read
 */
export async function GET(request: Request) {
  try {
    const account = await studentAccountFromRequest(request);
    if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to your UMaTeXPRESS account to continue.", 401);
    if (account.verificationRequired && !account.emailVerified) {
      throw new CampusEngineError("FORBIDDEN", "Verify your account email before continuing.", 403);
    }
    const recipients = await accountRecipients(account);
    const notifications = await listNotifications(recipients);
    return ok(
      { notifications, unread: await unreadNotificationCount(recipients) },
      { headers: { "Cache-Control": "no-store" } },
      request,
    );
  } catch (error) {
    return fail(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const account = await studentAccountFromRequest(request);
    if (!account) throw new CampusEngineError("UNAUTHORIZED", "Sign in to your UMaTeXPRESS account to continue.", 401);
    if (account.verificationRequired && !account.emailVerified) {
      throw new CampusEngineError("FORBIDDEN", "Verify your account email before continuing.", 403);
    }
    const recipients = await accountRecipients(account);
    const body = await request.json().catch(() => ({})) as { id?: string; all?: boolean };
    const updated = await markNotificationsRead(recipients, { id: body.id, all: body.all });
    return ok({ updated }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
