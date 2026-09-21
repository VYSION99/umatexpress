import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readCinemaMessage } from "@/lib/cinema-engine/messages";
import { consoleAudit } from "@/lib/console-audit";
import { incrementMetric, logEvent } from "@/lib/observability";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Watch reports, on the platform's existing moderation desk.
 *
 * A report is not an accusation and it blocks nothing: it is a row with the
 * evidence attached, deduplicated per room or per message while it is open, so
 * five students reporting the same thing is one card a moderator reads once.
 * Repeated reports raise the severity, which is what makes a pile of small
 * complaints visible without anyone having to count them by hand.
 *
 * The row's lifetime is the room's: once a room is deleted its chat is gone,
 * but the report survives as a record of what was decided and why.
 */

export const CINEMA_SIGNAL_SCHEMA_VERSION = "028_cinema_signals";
export const CINEMA_SIGNAL_SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const CINEMA_SIGNAL_STATUSES = ["OPEN", "REVIEWED", "DISMISSED"] as const;
export type CinemaSignalSeverity = (typeof CINEMA_SIGNAL_SEVERITIES)[number];
export type CinemaSignalStatus = (typeof CINEMA_SIGNAL_STATUSES)[number];

/** How many reports of one thing turn a card amber, then red. */
const MEDIUM_AT = 2;
const HIGH_AT = 4;
const REPORTERS_KEPT = 10;
/** The reason a student typed, as long as a chat message allows. */
const REASON_MAX = 500;

const CINEMA_SIGNAL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cinema_risk_signals (
    id TEXT PRIMARY KEY,
    signal_key TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL DEFAULT '',
    reporter_name TEXT NOT NULL DEFAULT '',
    report_count INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'OPEN',
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_signals_entity ON cinema_risk_signals(signal_key, entity_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_signals_status ON cinema_risk_signals(status, severity, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_signals_session ON cinema_risk_signals(session_id, status)",
];

let cinemaSignalTablesReady: Promise<void> | null = null;

export function ensureCinemaSignalTables() {
  cinemaSignalTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaSignals",
    version: CINEMA_SIGNAL_SCHEMA_VERSION,
    statements: CINEMA_SIGNAL_STATEMENTS,
  }).catch((error: unknown) => {
    cinemaSignalTablesReady = null;
    throw error;
  });
  return cinemaSignalTablesReady;
}

export type CinemaSignal = {
  id: string;
  signalKey: string;
  severity: CinemaSignalSeverity;
  entityType: "ROOM" | "MESSAGE";
  entityId: string;
  sessionId: string;
  reporterId: string;
  reporterName: string;
  reportCount: number;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: CinemaSignalStatus;
  reviewedBy: string;
  reviewedAt: string;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
};

function parseEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function signalView(row: Record<string, unknown>): CinemaSignal {
  return {
    id: String(row.id || ""),
    signalKey: String(row.signal_key || ""),
    severity: String(row.severity || "MEDIUM") as CinemaSignalSeverity,
    entityType: String(row.entity_type || "ROOM") === "MESSAGE" ? "MESSAGE" : "ROOM",
    entityId: String(row.entity_id || ""),
    sessionId: String(row.session_id || ""),
    reporterId: String(row.reporter_id || ""),
    reporterName: String(row.reporter_name || ""),
    reportCount: Number(row.report_count || 1),
    title: String(row.title || ""),
    detail: String(row.detail || ""),
    evidence: parseEvidence(row.evidence),
    status: String(row.status || "OPEN") as CinemaSignalStatus,
    reviewedBy: String(row.reviewed_by || ""),
    reviewedAt: String(row.reviewed_at || ""),
    reviewNote: String(row.review_note || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function severityFor(count: number): CinemaSignalSeverity {
  if (count >= HIGH_AT) return "HIGH";
  if (count >= MEDIUM_AT) return "MEDIUM";
  return "LOW";
}

function reasonFrom(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
}

export type CinemaReportResult = {
  signalId: string;
  severity: CinemaSignalSeverity;
  reportCount: number;
};

/**
 * Files a room or message report, or folds it into the open card for the same
 * thing. The message has to belong to the room it was reported in, which is
 * checked here rather than assumed, so a message id cannot pull a moderator
 * into a different room's conversation.
 */
export async function fileCinemaReport(input: {
  sessionId: string;
  sessionTitle: string;
  reporter: { id: string; name?: string };
  messageId?: unknown;
  reason?: unknown;
}): Promise<CinemaReportResult> {
  await requireTurso();
  await ensureCinemaSignalTables();
  const sessionId = String(input.sessionId || "").trim();
  const reporterId = String(input.reporter?.id || "").trim();
  if (!sessionId || !reporterId) throw new CampusEngineError("VALIDATION_ERROR", "A report needs a room and a reporter.", 400);
  const messageId = String(input.messageId || "").trim();
  let message = null;
  if (messageId) {
    message = await readCinemaMessage(messageId);
    if (!message || message.sessionId !== sessionId) {
      throw new CampusEngineError("NOT_FOUND", "That message is not in this room.", 404);
    }
  }
  const roomTitle = String(input.sessionTitle || "").slice(0, 120) || "Study room";
  const reason = reasonFrom(input.reason);
  const signalKey = message ? "CINEMA_MESSAGE_REPORT" : "CINEMA_ROOM_REPORT";
  const entityId = message ? message.id : sessionId;
  const stamp = new Date().toISOString();

  const existing = rowsToObjects(await turso(
    "SELECT id,report_count,evidence FROM cinema_risk_signals WHERE signal_key = ? AND entity_id = ? AND status = 'OPEN' LIMIT 1",
    [signalKey, entityId],
  ))[0];

  const detail = reason || (message ? "A student reported this message." : "A student reported this room.");
  const previousReporters = (() => {
    const previous = existing ? parseEvidence(existing.evidence).reports : [];
    return Array.isArray(previous) ? previous as Array<Record<string, unknown>> : [];
  })();
  // One person reporting twice is one report; the count is people, not clicks.
  const alreadyReported = previousReporters.some((entry) => entry?.by === reporterId);
  const reporters = alreadyReported
    ? previousReporters
    : [...previousReporters.slice(-(REPORTERS_KEPT - 1)), { by: reporterId, name: String(input.reporter?.name || "").slice(0, 80), at: stamp }];
  const evidence = {
    sessionId,
    roomTitle,
    ...(message ? { messageId: message.id, messageExcerpt: message.content.slice(0, 200), messageSenderId: message.senderId, messageSenderName: message.senderName } : {}),
    reports: reporters,
  };

  if (existing) {
    const count = Number(existing.report_count || 1) + (alreadyReported ? 0 : 1);
    const severity = severityFor(count);
    await turso(
      "UPDATE cinema_risk_signals SET severity = ?, reporter_id = ?, reporter_name = ?, report_count = ?, detail = ?, evidence = ?, updated_at = ? WHERE id = ?",
      [severity, reporterId, String(input.reporter?.name || "").slice(0, 80), count, detail, JSON.stringify(evidence), stamp, String(existing.id)],
    );
    logEvent("info", "cinema_report_filed", { sessionId, signalId: String(existing.id), messageId: message?.id || "", count });
    await incrementMetric("cinema_reports_filed");
    return { signalId: String(existing.id), severity, reportCount: count };
  }

  const id = crypto.randomUUID();
  const reportCount = 1;
  await turso(
    `INSERT INTO cinema_risk_signals
       (id,signal_key,severity,entity_type,entity_id,session_id,reporter_id,reporter_name,report_count,title,detail,evidence,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)`,
    [
      id,
      signalKey,
      severityFor(reportCount),
      message ? "MESSAGE" : "ROOM",
      entityId,
      sessionId,
      reporterId,
      String(input.reporter?.name || "").slice(0, 80),
      reportCount,
      message ? `Message reported in ${roomTitle}` : `Room reported: ${roomTitle}`,
      detail,
      JSON.stringify(evidence),
      stamp,
      stamp,
    ],
  );
  logEvent("info", "cinema_report_filed", { sessionId, signalId: id, messageId: message?.id || "", count: reportCount });
  await incrementMetric("cinema_reports_filed");
  return { signalId: id, severity: severityFor(reportCount), reportCount };
}

export async function listCinemaSignals(options: { status?: unknown; limit?: number } = {}) {
  await requireTurso();
  await ensureCinemaSignalTables();
  const wanted = String(options.status || "OPEN").toUpperCase();
  const status = (CINEMA_SIGNAL_STATUSES as readonly string[]).includes(wanted) ? wanted : "OPEN";
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 100), 1), 300);
  const rows = rowsToObjects(await turso(
    `SELECT id,signal_key,severity,entity_type,entity_id,session_id,reporter_id,reporter_name,report_count,title,detail,evidence,status,
       COALESCE(reviewed_by,'') AS reviewed_by,COALESCE(reviewed_at,'') AS reviewed_at,COALESCE(review_note,'') AS review_note,
       created_at,updated_at
     FROM cinema_risk_signals WHERE status = ? ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`,
    [status, limit],
  ));
  return rows.map(signalView);
}

export async function resolveCinemaSignal(input: { signalId: unknown; action: unknown; note?: unknown; actor: string }) {
  await requireTurso();
  await ensureCinemaSignalTables();
  const signalId = String(input.signalId || "").trim();
  const action = String(input.action || "").trim().toUpperCase();
  if (!signalId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a report to close.", 400);
  if (action !== "REVIEW" && action !== "DISMISS") throw new CampusEngineError("VALIDATION_ERROR", "Unknown report action.", 400);
  const note = reasonFrom(input.note);
  if (!note) throw new CampusEngineError("VALIDATION_ERROR", "Say what you found before closing the report.", 400);
  const row = rowsToObjects(await turso("SELECT id,status FROM cinema_risk_signals WHERE id = ? LIMIT 1", [signalId]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That report no longer exists.", 404);
  if (String(row.status) !== "OPEN") throw new CampusEngineError("INVALID_STATE", "That report is already closed.", 409);
  const status: CinemaSignalStatus = action === "REVIEW" ? "REVIEWED" : "DISMISSED";
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE cinema_risk_signals SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?",
    [status, String(input.actor || ""), stamp, note, stamp, signalId],
  );
  await consoleAudit({
    actor: input.actor,
    action: status === "REVIEWED" ? "cinema_signal_reviewed" : "cinema_signal_dismissed",
    targetType: "cinema_signal",
    targetReference: signalId,
    details: { note },
  });
  logEvent("info", "cinema_signal_resolved", { signalId, status });
  return { id: signalId, status, note, reviewedBy: String(input.actor || ""), reviewedAt: stamp };
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}
