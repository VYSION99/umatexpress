import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { requireConsoleRole } from "@/lib/console-auth";
import { runCuriosityShadow } from "@/lib/curiosity/shadow";
import { curiosityPilotEnabled } from "@/lib/curiosity/readiness";
import { curiosityFeedbackHealthAlerts, curiosityFeedbackSummary } from "@/lib/curiosity/feedback";
import { isTursoConfiguredRuntime } from "@/lib/turso";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN"]);
    if (account.delegateServices !== undefined) return Response.json({ ok: false, error: "Only the primary administrator can inspect curiosity policy diagnostics." }, { status: 403, headers });
    const [report, pilotEnabled, feedback] = await Promise.all([
      runCuriosityShadow(), curiosityPilotEnabled(),
      isTursoConfiguredRuntime().then((configured) => configured
        ? Promise.all([curiosityFeedbackSummary(), curiosityFeedbackHealthAlerts()])
          .then(([rows, alerts]) => ({ available: true, rows, alerts }))
          .catch(() => ({ available: false, rows: [], alerts: [] }))
        : { available: false, rows: [], alerts: [] }),
    ]);
    await consoleAudit({ actor: account.email, action: "CURIOSITY_SHADOW_READ", targetType: "curiosity_policy", targetReference: report.policyVersion, details: { failed: report.summary.failed } });
    return Response.json({ ok: true, pilotEnabled, report, feedback }, { headers });
  } catch (error) {
    const failure = campusErrorPayload(error);
    return Response.json(failure.body, { status: failure.status, headers });
  }
}
