import { ensureAdminAuditLogTable, isTursoConfiguredRuntime, turso } from "@/lib/turso";

/**
 * Console actions land in the same audit table the admin screens already use,
 * so one query answers "who did what" across every console service. Phase 2
 * relies on this for the D3 rule: every passenger-contact read is recorded.
 */
export async function consoleAudit(input: {
  actor: string;
  action: string;
  targetType: string;
  targetReference?: string;
  details?: Record<string, unknown> | string;
}) {
  if (!(await isTursoConfiguredRuntime())) return;
  await ensureAdminAuditLogTable();
  await turso(
    "INSERT INTO admin_audit_logs (id, admin_email, action, target_type, target_reference, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      crypto.randomUUID(),
      input.actor,
      input.action,
      input.targetType,
      input.targetReference || "",
      typeof input.details === "string" ? input.details : JSON.stringify(input.details || {}),
      new Date().toISOString(),
    ],
  );
}
