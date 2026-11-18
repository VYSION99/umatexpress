import { envValue } from "@/lib/runtime-env";
import { rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";
import { CURIOSITY_POLICY_VERSION, curiosityCatalog, type CuriosityServiceId } from "./catalog";

export type CuriosityFeedbackOutcome = "HELPFUL" | "NOT_HELPFUL";
export type CuriosityFeedbackAlert = {
  serviceId: string;
  policyVersion: string;
  helpful: number;
  notHelpful: number;
  total: number;
  notHelpfulRatio: number;
  holdRecommended: boolean;
};

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS curiosity_feedback_daily (
  day TEXT NOT NULL, policy_version TEXT NOT NULL, service_id TEXT NOT NULL,
  outcome TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,policy_version,service_id,outcome)
)`;
const CREATE_CLAIMS = `CREATE TABLE IF NOT EXISTS curiosity_feedback_claims (
  dedupe_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL
)`;
const SCHEMA = [
  CREATE_TABLE,
  CREATE_CLAIMS,
  "CREATE INDEX IF NOT EXISTS idx_curiosity_feedback_claims_expiry ON curiosity_feedback_claims(expires_at)",
];
const schemaReadyByUrl = new Map<string, Promise<void>>();
export async function ensureCuriosityFeedbackTables() {
  const url = (await envValue("TURSO_DATABASE_URL")) || "default";
  let ready = schemaReadyByUrl.get(url);
  if (!ready) {
    ready = runSchemaPass({ id: "curiosity-feedback-daily", version: "1", statements: SCHEMA }).catch((error: unknown) => {
      schemaReadyByUrl.delete(url);
      throw error;
    });
    schemaReadyByUrl.set(url, ready);
  }
  return ready;
}

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
  await ensureCuriosityFeedbackTables();
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
  return true;
}

export async function curiosityFeedbackSummary() {
  await ensureCuriosityFeedbackTables();
  const result = await turso(`SELECT policy_version, service_id, outcome, SUM(count) AS count FROM curiosity_feedback_daily
    WHERE day >= ? GROUP BY policy_version,service_id,outcome ORDER BY policy_version,service_id,outcome`,
  [reportingCutoff()]);
  return rowsToObjects(result).map((row) => ({ policyVersion: String(row.policy_version), serviceId: String(row.service_id), outcome: String(row.outcome), count: Number(row.count) }));
}

export async function curiosityFeedbackHealthAlerts(minSamples = 20, maxNotHelpfulRatio = 0.6): Promise<CuriosityFeedbackAlert[]> {
  await ensureCuriosityFeedbackTables();
  const sevenDayCutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const result = await turso(
    `SELECT policy_version, service_id, outcome, SUM(count) AS count
     FROM curiosity_feedback_daily
     WHERE day >= ?
     GROUP BY policy_version, service_id, outcome`,
    [sevenDayCutoff],
  );
  const grouped = new Map<string, { serviceId: string; policyVersion: string; helpful: number; notHelpful: number }>();
  for (const row of rowsToObjects(result)) {
    const policyVersion = String(row.policy_version);
    const serviceId = String(row.service_id);
    const key = `${policyVersion}:${serviceId}`;
    const entry = grouped.get(key) ?? { serviceId, policyVersion, helpful: 0, notHelpful: 0 };
    if (String(row.outcome) === "HELPFUL") entry.helpful += Number(row.count || 0);
    else if (String(row.outcome) === "NOT_HELPFUL") entry.notHelpful += Number(row.count || 0);
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((entry) => {
    const total = entry.helpful + entry.notHelpful;
    const notHelpfulRatio = total > 0 ? Number((entry.notHelpful / total).toFixed(4)) : 0;
    return {
      ...entry,
      total,
      notHelpfulRatio,
      holdRecommended: total >= minSamples && notHelpfulRatio > maxNotHelpfulRatio,
    };
  });
}

/** Daily cleanup also runs when no student or operator visits the pilot. */
export async function pruneCuriosityFeedback() {
  await ensureCuriosityFeedbackTables();
  const claims = await turso("DELETE FROM curiosity_feedback_claims WHERE expires_at < ?", [new Date().toISOString()]);
  const daily = await turso("DELETE FROM curiosity_feedback_daily WHERE day < ?", [reportingCutoff()]);
  return Number(claims.affected_row_count || 0) + Number(daily.affected_row_count || 0);
}
