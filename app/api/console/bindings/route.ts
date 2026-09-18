import { cloudflareBindingReports } from "@/lib/cloudflare-bindings";
import { staffEmailFromRequest } from "@/lib/staff-session";

/**
 * Which Cloudflare bindings this deployment actually has.
 *
 * Bindings are resolved at deploy time from the environment, so the only way to
 * know whether a rename or a disabled binding took effect is to ask the running
 * Worker. Reports names and account-side resource names only, never secrets.
 */
export async function GET(request: Request) {
  const adminEmail = await staffEmailFromRequest(request, ["ADMIN"]);
  if (!adminEmail) {
    return Response.json({ error: "Admin access is not authorised." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const report = await cloudflareBindingReports();
  return Response.json(
    { checkedAt: new Date().toISOString(), checkedBy: adminEmail, ...report },
    { headers: { "Cache-Control": "no-store" } },
  );
}
