import { listNotifications, markNotificationsRead } from "@/lib/notifications";
import { requireStudent } from "@/lib/student-auth";
import { fail, ok } from "@/lib/campus-engine/responses";

/**
 * The signed-in student's in-app notification feed.
 *
 * The rows are the same ones the mail dispatcher reads, so a message stays
 * readable here even when Resend is not configured. Both verbs need the
 * platform account; the feed is per-student, so the session is the gate and a
 * `Cache-Control: no-store` response may never be reused by a shared cache.
 *
 *   GET   the latest messages for the account
 *   PATCH mark one message, or the whole feed, as read
 */
export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    const notifications = await listNotifications(student.email);
    return ok(
      { notifications, unread: notifications.filter((item) => !item.read).length },
      { headers: { "Cache-Control": "no-store" } },
      request,
    );
  } catch (error) {
    return fail(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    const student = await requireStudent(request);
    const body = await request.json().catch(() => ({})) as { id?: string; all?: boolean };
    const updated = await markNotificationsRead(student.email, { id: body.id, all: body.all });
    return ok({ updated }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
