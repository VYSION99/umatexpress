import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { answerHostelGuide } from "@/lib/hostel-engine/help-assistant";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD", "ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-staff-guide-ai", { limit: 30, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (account.role === "LANDLORD") await resolveHostelHost(account);
    const body = await request.json() as { question?: unknown };
    return Response.json({ ok: true, ...(await answerHostelGuide(body.question, "staff", account.role)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
