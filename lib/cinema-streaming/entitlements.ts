import { CampusEngineError } from "@/lib/campus-engine/errors";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";

const SCHEMA_VERSION = "038_cinema_streaming_foundation";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cinema_streaming_quota_leases (
    quota_key TEXT PRIMARY KEY, entitlement_id TEXT NOT NULL, next_free_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cinema_streaming_entitlements (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, organizer_id TEXT NOT NULL, quota_key TEXT NOT NULL,
    plan_code TEXT NOT NULL, provider TEXT NOT NULL, free_tier INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'RESERVED', max_stage_unique INTEGER NOT NULL,
    max_stage_concurrent INTEGER NOT NULL, max_duration_minutes INTEGER NOT NULL, starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, initial_host_student_id TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_streaming_entitlements_quota ON cinema_streaming_entitlements(quota_key,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_streaming_entitlements_status ON cinema_streaming_entitlements(status,starts_at)",
  `CREATE TABLE IF NOT EXISTS cinema_stage_admissions (
    entitlement_id TEXT NOT NULL, student_id TEXT NOT NULL, first_admitted_at TEXT NOT NULL,
    last_claimed_at TEXT NOT NULL DEFAULT '', active_device_id TEXT NOT NULL DEFAULT '',
    active_until TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ADMITTED',
    PRIMARY KEY(entitlement_id,student_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_stage_admissions_active ON cinema_stage_admissions(entitlement_id,status,active_until)",
  `CREATE TABLE IF NOT EXISTS cinema_host_transfers (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, entitlement_id TEXT NOT NULL DEFAULT '',
    from_student_id TEXT NOT NULL, to_student_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
    requested_at TEXT NOT NULL, accepted_at TEXT NOT NULL DEFAULT '', cancelled_at TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_host_transfers_event ON cinema_host_transfers(event_id,requested_at DESC)",
  `CREATE TABLE IF NOT EXISTS cinema_jaas_monthly_users (
    month_key TEXT NOT NULL, student_id TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY(month_key,student_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_jaas_monthly_users_month ON cinema_jaas_monthly_users(month_key,first_seen_at)",
];

let ready: Promise<void> | null = null;
export function ensureCinemaStreamingEntitlements() {
  ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaStreaming", version: SCHEMA_VERSION, statements: SCHEMA })
    .catch((error) => { ready = null; throw error; });
  return ready;
}

export type FreeJaasPolicy = {
  enabled: boolean;
  maxStageUnique: number;
  maxDurationMinutes: number;
  periodDays: number;
};

export async function freeJaasPolicy(): Promise<FreeJaasPolicy> {
  const [jaas, free, maxStageUnique, maxDurationMinutes, periodDays] = await Promise.all([
    platformSettingEnabled("cinema_jaas_enabled"),
    platformSettingEnabled("cinema_jaas_free_events_enabled"),
    platformSettingNumber("cinema_jaas_free_stage_unique"),
    platformSettingNumber("cinema_jaas_free_event_minutes"),
    platformSettingNumber("cinema_jaas_free_period_days"),
  ]);
  return {
    enabled: jaas && free,
    maxStageUnique: Math.max(2, Math.min(12, Math.floor(maxStageUnique))),
    maxDurationMinutes: Math.max(15, Math.min(240, Math.floor(maxDurationMinutes))),
    periodDays: Math.max(1, Math.min(365, Math.floor(periodDays))),
  };
}

export function streamingQuotaKey(input: { organizerId: string; organizerType: string; ownerStudentId: string }) {
  const organizerType = String(input.organizerType || "").toUpperCase();
  if (organizerType === "STUDENT_GROUP") {
    if (!input.ownerStudentId) throw new TypeError("A student group quota needs its verified owner.");
    return `STUDENT:${input.ownerStudentId}`;
  }
  if (!input.organizerId) throw new TypeError("An approved organizer quota needs its organizer ID.");
  return `ORGANIZER:${input.organizerId}`;
}

export type CinemaStreamingEntitlement = {
  id: string;
  eventId: string;
  organizerId: string;
  quotaKey: string;
  planCode: string;
  provider: string;
  freeTier: boolean;
  status: string;
  maxStageUnique: number;
  maxStageConcurrent: number;
  maxDurationMinutes: number;
  startsAt: string;
  expiresAt: string;
  initialHostStudentId: string;
};

function entitlementView(row: Record<string, unknown>): CinemaStreamingEntitlement {
  return {
    id: String(row.id || ""), eventId: String(row.event_id || ""), organizerId: String(row.organizer_id || ""),
    quotaKey: String(row.quota_key || ""), planCode: String(row.plan_code || ""), provider: String(row.provider || ""),
    freeTier: Number(row.free_tier || 0) === 1, status: String(row.status || ""),
    maxStageUnique: Number(row.max_stage_unique || 0), maxStageConcurrent: Number(row.max_stage_concurrent || 0),
    maxDurationMinutes: Number(row.max_duration_minutes || 0), startsAt: String(row.starts_at || ""),
    expiresAt: String(row.expires_at || ""), initialHostStudentId: String(row.initial_host_student_id || ""),
  };
}

export async function entitlementByEvent(eventId: string) {
  await ensureCinemaStreamingEntitlements();
  const row = rowsToObjects(await turso("SELECT * FROM cinema_streaming_entitlements WHERE event_id=? LIMIT 1", [eventId]))[0];
  return row ? entitlementView(row) : null;
}

export async function entitlementBySession(sessionId: string) {
  await ensureCinemaStreamingEntitlements();
  const row = rowsToObjects(await turso(`SELECT se.* FROM cinema_streaming_entitlements se
    JOIN cinema_events e ON e.id=se.event_id WHERE e.session_id=? LIMIT 1`, [sessionId]))[0];
  return row ? entitlementView(row) : null;
}

export async function cancelReservedFreeJaasEntitlement(eventId: string) {
  await ensureCinemaStreamingEntitlements();
  const entitlement = await entitlementByEvent(eventId);
  if (!entitlement || entitlement.provider !== "JAAS" || entitlement.status !== "RESERVED") return { cancelled: false };
  const results = await tursoTransaction([
    { sql: "DELETE FROM cinema_stage_admissions WHERE entitlement_id=?", args: [entitlement.id] },
    { sql: "DELETE FROM cinema_streaming_quota_leases WHERE quota_key=? AND entitlement_id=?", args: [entitlement.quotaKey, entitlement.id] },
    { sql: "DELETE FROM cinema_streaming_entitlements WHERE id=? AND status='RESERVED'", args: [entitlement.id] },
  ]);
  return { cancelled: Number(results[2]?.affected_row_count || 0) === 1 };
}

export async function admitFreeStageIdentityBySession(input: { sessionId: string; studentId: string; now?: Date }) {
  const entitlement = await entitlementBySession(input.sessionId);
  if (!entitlement || !entitlement.freeTier || entitlement.provider !== "JAAS") return { managed: false, admitted: false };
  if (!["RESERVED", "ACTIVE"].includes(entitlement.status)) throw new CampusEngineError("INVALID_STATE", "This managed stage is no longer active.", 409);
  const studentId = String(input.studentId || "").trim();
  if (!studentId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a verified stage participant.", 400);
  const stamp = (input.now ?? new Date()).toISOString();
  const [inserted] = await tursoTransaction([{ sql: `INSERT INTO cinema_stage_admissions(entitlement_id,student_id,first_admitted_at,status)
    SELECT ?,?,?,'ADMITTED' WHERE (SELECT COUNT(*) FROM cinema_stage_admissions WHERE entitlement_id=? AND status='ADMITTED')<?
    ON CONFLICT(entitlement_id,student_id) DO NOTHING`, args: [entitlement.id, studentId, stamp, entitlement.id, entitlement.maxStageUnique] }]);
  if (Number(inserted?.affected_row_count || 0) !== 1) {
    const existing = rowsToObjects(await turso("SELECT student_id FROM cinema_stage_admissions WHERE entitlement_id=? AND student_id=? AND status='ADMITTED' LIMIT 1", [entitlement.id, studentId]))[0];
    if (!existing) throw new CampusEngineError("CONFLICT", `The free stage has already admitted its ${entitlement.maxStageUnique} unique participants.`, 409);
  }
  return { managed: true, admitted: true, entitlement };
}

export async function reserveFreeJaasEntitlement(input: {
  eventId: string;
  organizerId: string;
  organizerType: string;
  ownerStudentId: string;
  hostStudentId: string;
  startsAt: string;
  durationMinutes: number;
  createdBy: string;
  policy?: FreeJaasPolicy;
  now?: Date;
}) {
  await ensureCinemaStreamingEntitlements();
  const existing = await entitlementByEvent(input.eventId);
  if (existing) return existing;
  const policy = input.policy ?? await freeJaasPolicy();
  if (!policy.enabled) throw new CampusEngineError("CONFIG_REQUIRED", "Free managed-stage events are not currently available.", 503);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > policy.maxDurationMinutes) {
    throw new CampusEngineError("VALIDATION_ERROR", `A free managed-stage event may run for up to ${policy.maxDurationMinutes} minutes.`, 400);
  }
  const starts = Date.parse(input.startsAt);
  if (!Number.isFinite(starts)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid event start time.", 400);
  const quotaKey = streamingQuotaKey(input);
  const id = crypto.randomUUID();
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const nextFreeAt = new Date(now.getTime() + policy.periodDays * 24 * 60 * 60_000).toISOString();
  const expiresAt = new Date(starts + (input.durationMinutes + 60) * 60_000).toISOString();
  const results = await tursoTransaction([
    { sql: `INSERT INTO cinema_streaming_quota_leases(quota_key,entitlement_id,next_free_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(quota_key) DO UPDATE SET entitlement_id=excluded.entitlement_id,next_free_at=excluded.next_free_at,updated_at=excluded.updated_at
      WHERE cinema_streaming_quota_leases.next_free_at<=?`, args: [quotaKey, id, nextFreeAt, stamp, stamp] },
    { sql: `INSERT INTO cinema_streaming_entitlements(id,event_id,organizer_id,quota_key,plan_code,provider,free_tier,status,
      max_stage_unique,max_stage_concurrent,max_duration_minutes,starts_at,expires_at,initial_host_student_id,created_by,created_at,updated_at)
      SELECT ?,?,?,?,'FREE_PUBLIC_JAAS','JAAS',1,'RESERVED',?,?,?, ?,?,?,?, ?,?
      WHERE EXISTS(SELECT 1 FROM cinema_streaming_quota_leases WHERE quota_key=? AND entitlement_id=? AND updated_at=?)`,
      args: [id, input.eventId, input.organizerId, quotaKey, policy.maxStageUnique, policy.maxStageUnique, policy.maxDurationMinutes,
        input.startsAt, expiresAt, input.hostStudentId, input.createdBy, stamp, stamp, quotaKey, id, stamp] },
    { sql: `INSERT INTO cinema_stage_admissions(entitlement_id,student_id,first_admitted_at,status)
      SELECT ?,?,?,'ADMITTED' WHERE EXISTS(SELECT 1 FROM cinema_streaming_entitlements WHERE id=?)`, args: [id, input.hostStudentId, stamp, id] },
  ]);
  if (Number(results[1]?.affected_row_count || 0) !== 1) {
    const lease = rowsToObjects(await turso("SELECT next_free_at FROM cinema_streaming_quota_leases WHERE quota_key=? LIMIT 1", [quotaKey]))[0];
    throw new CampusEngineError("CONFLICT", `This organizer's next free managed-stage event is available after ${String(lease?.next_free_at || nextFreeAt)}.`, 409);
  }
  return (await entitlementByEvent(input.eventId)) as CinemaStreamingEntitlement;
}

export async function claimFreeStageDevice(input: {
  eventId: string;
  studentId: string;
  deviceSessionId: string;
  now?: Date;
  claimMinutes?: number;
}) {
  await ensureCinemaStreamingEntitlements();
  const entitlement = await entitlementByEvent(input.eventId);
  if (!entitlement || !entitlement.freeTier || entitlement.provider !== "JAAS") {
    throw new CampusEngineError("FORBIDDEN", "This event does not have a free managed-stage entitlement.", 403);
  }
  if (!["RESERVED", "ACTIVE"].includes(entitlement.status)) throw new CampusEngineError("INVALID_STATE", "This stage entitlement is no longer active.", 409);
  const studentId = String(input.studentId || "").trim();
  const deviceSessionId = String(input.deviceSessionId || "").trim();
  if (!studentId || deviceSessionId.length < 16 || deviceSessionId.length > 160) throw new CampusEngineError("VALIDATION_ERROR", "A valid account and stage device session are required.", 400);
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const activeUntil = new Date(now.getTime() + Math.max(2, Math.min(15, Math.floor(input.claimMinutes ?? 5))) * 60_000).toISOString();
  const results = await tursoTransaction([
    { sql: `INSERT INTO cinema_stage_admissions(entitlement_id,student_id,first_admitted_at,status)
      SELECT ?,?,?,'ADMITTED' WHERE (SELECT COUNT(*) FROM cinema_stage_admissions WHERE entitlement_id=? AND status='ADMITTED')<?
      ON CONFLICT(entitlement_id,student_id) DO NOTHING`, args: [entitlement.id, studentId, stamp, entitlement.id, entitlement.maxStageUnique] },
    { sql: `UPDATE cinema_stage_admissions SET active_device_id=?,active_until=?,last_claimed_at=?
      WHERE entitlement_id=? AND student_id=? AND status='ADMITTED'
        AND (active_device_id='' OR active_device_id=? OR active_until<=?)`,
      args: [deviceSessionId, activeUntil, stamp, entitlement.id, studentId, deviceSessionId, stamp] },
    { sql: "UPDATE cinema_streaming_entitlements SET status='ACTIVE',updated_at=? WHERE id=? AND status='RESERVED'", args: [stamp, entitlement.id] },
  ]);
  if (Number(results[1]?.affected_row_count || 0) !== 1) {
    const admission = rowsToObjects(await turso("SELECT student_id,active_device_id,active_until FROM cinema_stage_admissions WHERE entitlement_id=? AND student_id=? LIMIT 1", [entitlement.id, studentId]))[0];
    if (admission) throw new CampusEngineError("CONFLICT", "This stage account is already active on another device.", 409);
    throw new CampusEngineError("CONFLICT", `The free stage has already admitted its ${entitlement.maxStageUnique} unique participants.`, 409);
  }
  const count = rowsToObjects(await turso("SELECT COUNT(*) AS count FROM cinema_stage_admissions WHERE entitlement_id=? AND status='ADMITTED'", [entitlement.id]))[0];
  return { entitlement: { ...entitlement, status: "ACTIVE" }, uniqueStageParticipants: Number(count?.count || 0), activeUntil };
}

export async function releaseFreeStageDevice(input: { eventId: string; studentId: string; deviceSessionId: string }) {
  await ensureCinemaStreamingEntitlements();
  const entitlement = await entitlementByEvent(input.eventId);
  if (!entitlement) return { released: false };
  const result = await turso(`UPDATE cinema_stage_admissions SET active_device_id='',active_until=''
    WHERE entitlement_id=? AND student_id=? AND active_device_id=?`, [entitlement.id, input.studentId, input.deviceSessionId]);
  return { released: Number(result.affected_row_count || 0) === 1 };
}

export async function releaseFreeStageIdentityDevicesBySession(input: { sessionId: string; studentId: string }) {
  const entitlement = await entitlementBySession(input.sessionId);
  if (!entitlement || entitlement.provider !== "JAAS") return { managed: false, released: false };
  const result = await turso(`UPDATE cinema_stage_admissions SET active_device_id='',active_until=''
    WHERE entitlement_id=? AND student_id=?`, [entitlement.id, input.studentId]);
  return { managed: true, released: Number(result.affected_row_count || 0) === 1 };
}

function monthKey(now: Date) {
  return now.toISOString().slice(0, 7);
}

/**
 * Local MAU guard for the free JaaS pool. This deliberately counts verified
 * application identities, while the provider invoice remains authoritative.
 * Existing identities keep working when the threshold is reached; only the
 * first token for another identity is refused.
 */
export async function claimFreeJaasMonthlyIdentity(input: { studentId: string; now?: Date }) {
  await ensureCinemaStreamingEntitlements();
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const key = monthKey(now);
  const [warning, highWarning, stopFree] = await Promise.all([
    platformSettingNumber("cinema_jaas_mau_warning"),
    platformSettingNumber("cinema_jaas_mau_high_warning"),
    platformSettingNumber("cinema_jaas_mau_stop_free"),
  ]);
  const stop = Math.max(1, Math.floor(stopFree));
  await turso(`INSERT INTO cinema_jaas_monthly_users(month_key,student_id,first_seen_at,last_seen_at)
    SELECT ?,?,?,? WHERE EXISTS(
      SELECT 1 WHERE EXISTS(SELECT 1 FROM cinema_jaas_monthly_users WHERE month_key=? AND student_id=?)
      OR (SELECT COUNT(*) FROM cinema_jaas_monthly_users WHERE month_key=?)<?
    ) ON CONFLICT(month_key,student_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
  [key, input.studentId, stamp, stamp, key, input.studentId, key, stop]);
  const existing = rowsToObjects(await turso(
    "SELECT student_id FROM cinema_jaas_monthly_users WHERE month_key=? AND student_id=? LIMIT 1",
    [key, input.studentId],
  ))[0];
  if (!existing) {
    throw new CampusEngineError("CONFLICT", "The free managed-stage monthly allowance is full. Ask an administrator about a paid or subsidized event.", 409);
  }
  const countRow = rowsToObjects(await turso(
    "SELECT COUNT(*) AS count FROM cinema_jaas_monthly_users WHERE month_key=?",
    [key],
  ))[0];
  const count = Number(countRow?.count || 0);
  return {
    month: key,
    count,
    level: count >= stop ? "STOP" as const : count >= Math.floor(highWarning) ? "HIGH" as const : count >= Math.floor(warning) ? "WARNING" as const : "OK" as const,
    stopFree: stop,
  };
}

export async function endStreamingEntitlementBySession(sessionId: string, now = new Date()) {
  await ensureCinemaStreamingEntitlements();
  const entitlement = await entitlementBySession(sessionId);
  if (!entitlement) return { ended: false };
  const stamp = now.toISOString();
  const results = await tursoTransaction([
    { sql: "UPDATE cinema_stage_admissions SET active_device_id='',active_until='' WHERE entitlement_id=?", args: [entitlement.id] },
    { sql: "UPDATE cinema_streaming_entitlements SET status='ENDED',updated_at=? WHERE id=? AND status IN ('RESERVED','ACTIVE')", args: [stamp, entitlement.id] },
  ]);
  return { ended: Number(results[1]?.affected_row_count || 0) === 1 };
}

