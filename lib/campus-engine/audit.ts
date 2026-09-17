import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { ensureCampusRideTables } from "@/lib/campus-ride";

export async function campusAudit(input: { actorType: "student" | "driver" | "admin" | "system"; actorId?: string; action: string; targetType: string; targetReference: string; details?: Record<string, unknown> | string }) {
  if (!(await isTursoConfiguredRuntime())) return;
  await ensureCampusRideTables();
  const details = typeof input.details === "string" ? input.details : JSON.stringify(input.details || {});
  await turso("INSERT INTO campus_audit_logs (id,actor_type,actor_id,action,target_type,target_reference,details,created_at) VALUES (?,?,?,?,?,?,?,?)", [
    crypto.randomUUID(),
    input.actorType,
    input.actorId || "",
    input.action,
    input.targetType,
    input.targetReference,
    details,
    new Date().toISOString(),
  ]);
}

