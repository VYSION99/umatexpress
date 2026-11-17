import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";
import { CURIOSITY_POLICY_VERSION, curiosityCatalog, type CuriosityServiceId } from "./catalog";

export type CuriosityFeedbackOutcome = "HELPFUL" | "NOT_HELPFUL";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS curiosity_feedback_daily (
  day TEXT NOT NULL, policy_version TEXT NOT NULL, service_id TEXT NOT NULL,
  outcome TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,policy_version,service_id,outcome)
)`;
const CREATE_CLAIMS = `CREATE TABLE IF NOT EXISTS curiosity_feedback_claims (
  dedupe_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL
)`;
const reportingCutoff = () => new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString().slice(0, 10);

export function validCuriosityFeedback(value: unknown): value is { serviceId: CuriosityServiceId; policyVersion: string; outcome: CuriosityFeedbackOutcome; feedbackToken: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 4
    && row.policyVersion === CURIOSITY_POLICY_VERSION
    && (row.outcome === "HELPFUL" || row.outcome === "NOT_HELPFUL")
    && typeof row.feedbackToken === "string" && row.feedbackToken.length <= 200
    && curiosityCatalog().some((service) => service.id === row.serviceId && service.launched);
}

/** A one-day opaque dedupe hash prevents repeat counts; no account or goal is stored. */
export async function recordCuriosityFeedback(input: { serviceId: CuriosityServiceId; policyVersion: string; outcome: CuriosityFeedbackOutcome; dedupeHash: string }) {
  await turso(CREATE_TABLE);
  await turso(CREATE_CLAIMS);
  await turso("CREATE INDEX IF NOT EXISTS idx_curiosity_feedback_claims_expiry ON curiosity_feedback_claims(expires_at)");
  const day = new Date().toISOString().slice(0, 10);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  try {
    await tursoTransaction([
      { sql: "INSERT INTO curiosity_feedback_claims (dedupe_hash,expires_at) VALUES (?,?)", args: [input.dedupeHash, expiresAt] },
      { sql: `INSERT INTO curiosity_feedback_daily (day,policy_version,service_id,outcome,count)
        VALUES (?,?,?,?,1) ON CONFLICT(day,policy_version,service_id,outcome)
        DO UPDATE SET count = curiosity_feedback_daily.count + 1`, args: [day, input.policyVersion, input.serviceId, input.outcome] },
    ]);
  } catch (error) {
    const existing = rowsToObjects(await turso("SELECT dedupe_hash FROM curiosity_feedback_claims WHERE dedupe_hash = ? LIMIT 1", [input.dedupeHash]));
    if (existing.length) return false;
    throw error;
  }
  await turso("DELETE FROM curiosity_feedback_daily WHERE day < ?", [reportingCutoff()]);
  await turso("DELETE FROM curiosity_feedback_claims WHERE expires_at < ?", [new Date().toISOString()]);
  return true;
}

export async function curiosityFeedbackSummary() {
  await turso(CREATE_TABLE);
  await turso(CREATE_CLAIMS);
  await turso("CREATE INDEX IF NOT EXISTS idx_curiosity_feedback_claims_expiry ON curiosity_feedback_claims(expires_at)");
  await turso("DELETE FROM curiosity_feedback_daily WHERE day < ?", [reportingCutoff()]);
  await turso("DELETE FROM curiosity_feedback_claims WHERE expires_at < ?", [new Date().toISOString()]);
  const result = await turso(`SELECT policy_version, service_id, outcome, SUM(count) AS count FROM curiosity_feedback_daily
    WHERE day >= ? GROUP BY policy_version,service_id,outcome ORDER BY policy_version,service_id,outcome`,
  [reportingCutoff()]);
  return rowsToObjects(result).map((row) => ({ policyVersion: String(row.policy_version), serviceId: String(row.service_id), outcome: String(row.outcome), count: Number(row.count) }));
}

/** Daily cleanup also runs when no student or operator visits the pilot. */
export async function pruneCuriosityFeedback() {
  await turso(CREATE_TABLE);
  await turso(CREATE_CLAIMS);
  await turso("DELETE FROM curiosity_feedback_claims WHERE expires_at < ?", [new Date().toISOString()]);
  await turso("DELETE FROM curiosity_feedback_daily WHERE day < ?", [reportingCutoff()]);
}
