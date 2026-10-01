import { consoleAccountFromRequest } from "@/lib/console-auth";
import { listNotifications, markNotificationsRead, unreadNotificationCount } from "@/lib/notifications";
import { fail, ok } from "@/lib/campus-engine/responses";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const account = await consoleAccountFromRequest(request);
    if (!account) return Response.json({ error: "Sign in to the console." }, { status: 401, headers: HEADERS });
    const notifications = await listNotifications(account.email);
    return ok({ notifications, unread: await unreadNotificationCount(account.email) }, { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: Request) {
  try {
    const account = await consoleAccountFromRequest(request);
    if (!account) return Response.json({ error: "Sign in to the console." }, { status: 401, headers: HEADERS });
    const body = await request.json().catch(() => ({})) as { id?: string; all?: boolean };
    const updated = await markNotificationsRead(account.email, { id: body.id, all: body.all });
    return ok({ updated }, { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
