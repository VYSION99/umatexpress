import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { ensureHostelMessageTables } from "@/lib/hostel-engine/message-schema";
import { ensureHostelPhotoTables } from "@/lib/hostel-engine/photos";
import { ensureHostelResidencyTables } from "@/lib/hostel-engine/residency";
import { incrementMetric, logEvent } from "@/lib/observability";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Fraud and abuse signals.
 *
 * The platform does not score people; it records things a reviewer should look
 * at, with the evidence that raised them. Every signal is deduplicated per
 * entity while it is open, so a rescan refreshes the row instead of stacking
 * duplicates, and a resolved signal can be raised again if the pattern returns.
 * Nothing here blocks a listing or a booking on its own — a person decides.
 */

export const HOSTEL_SIGNAL_SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const HOSTEL_SIGNAL_STATUSES = ["OPEN", "REVIEWED", "DISMISSED"] as const;
export type HostelSignalSeverity = (typeof HOSTEL_SIGNAL_SEVERITIES)[number];
export type HostelSignalStatus = (typeof HOSTEL_SIGNAL_STATUSES)[number];

/** A period needs this many live listings before a median means anything. */
const OUTLIER_MIN_SAMPLE = 5;
const OUTLIER_HIGH_MULTIPLE = 5;
const OUTLIER_LOW_MULTIPLE = 0.3;
const LISTING_FARM_THRESHOLD = 20;
const BED_HOARDING_THRESHOLD = 3;
const MESSAGE_SCAN_LIMIT = 200;
const MESSAGE_SCAN_DAYS = 30;
const MOMO_PATTERN = /\b0\d{9}\b|\b(momo|mobile money|mtn|telecel|airteltigo)\b/i;
const MONEY_CONTEXT_PATTERN = /\b(pay|send|transfer|deposit|cedis|ghs|gh₵)\b/i;

const SIGNAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_risk_signals (
    id TEXT PRIMARY KEY,
    signal_key TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    landlord_id TEXT NOT NULL DEFAULT '',
    property_id TEXT NOT NULL DEFAULT '',
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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_signals_entity ON hostel_risk_signals(signal_key, entity_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_signals_status ON hostel_risk_signals(status, severity, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_signals_landlord ON hostel_risk_signals(landlord_id, status)",
];

export type HostelSignal = {
  id: string;
  signalKey: string;
  severity: HostelSignalSeverity;
  entityType: string;
  entityId: string;
  landlordId: string;
  propertyId: string;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: HostelSignalStatus;
  reviewedBy: string;
  reviewedAt: string;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
};

let signalTablesReady: Promise<void> | null = null;

export function ensureHostelSignalTables() {
  signalTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelSignals", version: "023_hostel_signals", statements: SIGNAL_SCHEMA_STATEMENTS });
  })().catch((error: unknown) => {
    signalTablesReady = null;
    throw error;
  });
  return signalTablesReady;
}

function signalView(row: Record<string, unknown>): HostelSignal {
  let evidence: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.evidence || "{}"));
    if (parsed && typeof parsed === "object") evidence = parsed as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  return {
    id: String(row.id || ""),
    signalKey: String(row.signal_key || ""),
    severity: String(row.severity || "MEDIUM") as HostelSignalSeverity,
    entityType: String(row.entity_type || ""),
    entityId: String(row.entity_id || ""),
    landlordId: String(row.landlord_id || ""),
    propertyId: String(row.property_id || ""),
    title: String(row.title || ""),
    detail: String(row.detail || ""),
    evidence,
    status: String(row.status || "OPEN") as HostelSignalStatus,
    reviewedBy: String(row.reviewed_by || ""),
    reviewedAt: String(row.reviewed_at || ""),
    reviewNote: String(row.review_note || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

/** One row per open pattern; a rescan refreshes it rather than stacking copies. */
export async function recordHostelSignal(input: {
  signalKey: string;
  severity: HostelSignalSeverity;
  entityType: string;
  entityId: string;
  landlordId?: string;
  propertyId?: string;
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
}) {
  await ensureHostelSignalTables();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO hostel_risk_signals (id,signal_key,severity,entity_type,entity_id,landlord_id,property_id,title,detail,evidence,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)
     ON CONFLICT(signal_key, entity_id, status) DO UPDATE SET
       severity = excluded.severity, landlord_id = excluded.landlord_id, property_id = excluded.property_id,
       title = excluded.title, detail = excluded.detail, evidence = excluded.evidence, updated_at = excluded.updated_at`,
    [
      crypto.randomUUID(), input.signalKey, input.severity, input.entityType, input.entityId,
      String(input.landlordId || ""), String(input.propertyId || ""), input.title, input.detail,
      JSON.stringify(input.evidence || {}), stamp, stamp,
    ],
  );
}

export async function listHostelSignals(options: { status?: string; limit?: number } = {}) {
  await ensureHostelSignalTables();
  const status = HOSTEL_SIGNAL_STATUSES.includes(String(options.status || "").toUpperCase() as HostelSignalStatus)
    ? String(options.status).toUpperCase()
    : "OPEN";
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 100), 1), 300);
  const rows = rowsToObjects(await turso(
    `SELECT id,signal_key,severity,entity_type,entity_id,landlord_id,property_id,title,detail,evidence,status,
       COALESCE(reviewed_by,'') AS reviewed_by,COALESCE(reviewed_at,'') AS reviewed_at,COALESCE(review_note,'') AS review_note,
       created_at,updated_at
     FROM hostel_risk_signals WHERE status = ? ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`,
    [status, limit],
  ));
  return rows.map(signalView);
}

export async function resolveHostelSignal(input: { signalId: string; action: unknown; note?: unknown; actor: string }) {
  await ensureHostelSignalTables();
  const signalId = String(input.signalId || "").trim();
  const action = String(input.action || "").trim().toUpperCase();
  if (!signalId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a signal to resolve.", 400);
  if (!["REVIEW", "DISMISS"].includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Unknown signal action.", 400);
  const note = String(input.note || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!note) throw new CampusEngineError("VALIDATION_ERROR", "Say what you found before closing the signal.", 400);
  const row = rowsToObjects(await turso("SELECT id,status FROM hostel_risk_signals WHERE id = ? LIMIT 1", [signalId]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That signal no longer exists.", 404);
  if (String(row.status) !== "OPEN") throw new CampusEngineError("INVALID_STATE", "That signal is already closed.", 409);
  const status: HostelSignalStatus = action === "REVIEW" ? "REVIEWED" : "DISMISSED";
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_risk_signals SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?",
    [status, String(input.actor || ""), stamp, note, stamp, signalId],
  );
  await consoleAudit({
    actor: input.actor,
    action: status === "REVIEWED" ? "hostel_signal_reviewed" : "hostel_signal_dismissed",
    targetType: "hostel_signal",
    targetReference: signalId,
    details: { note },
  });
  logEvent("info", "hostel_signal_resolved", { signalId, status });
  return { id: signalId, status, note, reviewedBy: String(input.actor || ""), reviewedAt: stamp };
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function money(pesewas: number) {
  return `GH₵ ${(pesewas / 100).toFixed(2)}`;
}

/**
 * Recomputes every rule and refreshes the open rows. It is safe to run as often
 * as an administrator likes: the dedupe key is the pattern and the entity, not
 * the moment it was noticed.
 */
export async function scanHostelSignals(options: { now?: Date } = {}) {
  await Promise.all([ensureHostelSignalTables(), ensureHostelResidencyTables(), ensureHostelMessageTables(), ensureHostelPhotoTables()]);
  const now = options.now ?? new Date();
  const raised: { signalKey: string; entityId: string; severity: HostelSignalSeverity }[] = [];

  const live = rowsToObjects(await turso(
    `SELECT l.id AS listing_id,l.price AS price,l.period_id AS period_id,l.status AS listing_status,
       r.property_id AS property_id,p.landlord_id AS landlord_id,p.name AS property_name,
       COALESCE(h.kyc_status,'PENDING') AS kyc_status,h.name AS landlord_name
     FROM hostel_listings l
     JOIN hostel_spaces s ON s.id = l.space_id
     JOIN hostel_rooms r ON r.id = s.room_id
     JOIN hostel_properties p ON p.id = r.property_id
     JOIN hostel_landlords h ON h.id = p.landlord_id
     WHERE l.status IN ('APPROVED','PENDING_REVIEW')`,
  ));

  // 1. A price far from the year's median is either a mistake or bait.
  const byPeriod = new Map<string, number[]>();
  live.forEach((row) => {
    const periodId = String(row.period_id || "");
    byPeriod.set(periodId, [...(byPeriod.get(periodId) || []), Number(row.price || 0)]);
  });
  for (const row of live) {
    const samples = byPeriod.get(String(row.period_id || "")) || [];
    if (samples.length < OUTLIER_MIN_SAMPLE) continue;
    const middle = median(samples);
    const price = Number(row.price || 0);
    if (!middle || !price) continue;
    const multiple = price / middle;
    if (multiple >= OUTLIER_HIGH_MULTIPLE || multiple <= OUTLIER_LOW_MULTIPLE) {
      const severity: HostelSignalSeverity = "MEDIUM";
      await recordHostelSignal({
        signalKey: "price_outlier",
        severity,
        entityType: "LISTING",
        entityId: String(row.listing_id),
        landlordId: String(row.landlord_id),
        propertyId: String(row.property_id),
        title: multiple >= OUTLIER_HIGH_MULTIPLE ? "Bed priced far above the year" : "Bed priced far below the year",
        detail: `${row.property_name || "A property"} lists a bed at ${money(price)}, against a median of ${money(middle)} for the same academic year (${multiple.toFixed(1)}×).`,
        evidence: { price, median: middle, multiple: Number(multiple.toFixed(2)), samples: samples.length },
      });
      raised.push({ signalKey: "price_outlier", entityId: String(row.listing_id), severity });
    }
  }

  // 2. A live listing whose landlord has not passed verification.
  const unverified = new Map<string, { rows: Record<string, unknown>[]; listings: number }>();
  live.filter((row) => String(row.kyc_status) !== "VERIFIED" && String(row.listing_status) === "APPROVED").forEach((row) => {
    const landlordId = String(row.landlord_id || "");
    const entry = unverified.get(landlordId) || { rows: [], listings: 0 };
    entry.rows.push(row);
    entry.listings += 1;
    unverified.set(landlordId, entry);
  });
  for (const [landlordId, entry] of unverified) {
    const first = entry.rows[0];
    await recordHostelSignal({
      signalKey: "kyc_unverified_live",
      severity: "HIGH",
      entityType: "LANDLORD",
      entityId: landlordId,
      landlordId,
      propertyId: String(first.property_id || ""),
      title: "Approved listings without verification",
      detail: `${first.landlord_name || "A landlord"} has ${entry.listings} approved listing${entry.listings === 1 ? "" : "s"} while KYC is ${first.kyc_status}.`,
      evidence: { kycStatus: String(first.kyc_status || ""), listings: entry.listings },
    });
    raised.push({ signalKey: "kyc_unverified_live", entityId: landlordId, severity: "HIGH" });
  }

  // 3. One landlord filling a year with beds all at once.
  const farmed = new Map<string, number>();
  live.forEach((row) => {
    const key = `${row.landlord_id}:${row.period_id}`;
    farmed.set(key, (farmed.get(key) || 0) + 1);
  });
  for (const [key, count] of farmed) {
    if (count < LISTING_FARM_THRESHOLD) continue;
    const [landlordId, periodId] = key.split(":");
    await recordHostelSignal({
      signalKey: "listing_farm",
      severity: "MEDIUM",
      entityType: "LANDLORD",
      entityId: key,
      landlordId,
      title: "Unusually many beds in one year",
      detail: `One landlord has ${count} live listings in the same academic year.`,
      evidence: { listings: count, periodId },
    });
    raised.push({ signalKey: "listing_farm", entityId: key, severity: "MEDIUM" });
  }

  // 4. The same uploaded photo attached to two different buildings.
  const reused = rowsToObjects(await turso(
    `SELECT r2_key, COUNT(DISTINCT property_id) AS properties, GROUP_CONCAT(DISTINCT property_id) AS property_ids, COUNT(*) AS photos
     FROM hostel_property_photos WHERE COALESCE(r2_key,'') <> '' GROUP BY r2_key HAVING properties > 1`,
  ));
  for (const row of reused) {
    const r2Key = String(row.r2_key || "");
    await recordHostelSignal({
      signalKey: "photo_reused",
      severity: "MEDIUM",
      entityType: "PHOTO",
      entityId: r2Key,
      title: "One photo used on several buildings",
      detail: `The same uploaded image appears on ${row.properties} different properties.`,
      evidence: { propertyIds: String(row.property_ids || "").split(","), photos: Number(row.photos || 0) },
    });
    raised.push({ signalKey: "photo_reused", entityId: r2Key, severity: "MEDIUM" });
  }

  // 5. One student holding more beds than a person can live in.
  const hoarded = rowsToObjects(await turso(
    `SELECT student_email, period_id, COUNT(*) AS beds FROM hostel_bookings
     WHERE status = 'PAID' GROUP BY student_email, period_id HAVING beds > ?`,
    [BED_HOARDING_THRESHOLD],
  ));
  for (const row of hoarded) {
    const key = `${row.student_email}:${row.period_id}`;
    await recordHostelSignal({
      signalKey: "bed_hoarding",
      severity: "MEDIUM",
      entityType: "STUDENT",
      entityId: key,
      title: "One student holds several beds",
      detail: `${row.student_email} has ${row.beds} paid beds in the same academic year.`,
      evidence: { beds: Number(row.beds || 0), periodId: String(row.period_id || "") },
    });
    raised.push({ signalKey: "bed_hoarding", entityId: key, severity: "MEDIUM" });
  }

  // 6. A thread drifting toward an off-platform mobile-money payment.
  const since = new Date(now.getTime() - MESSAGE_SCAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const messages = rowsToObjects(await turso(
    `SELECT m.id AS id,m.booking_id AS booking_id,m.content AS content,m.sender_type AS sender_type,m.created_at AS created_at,
       b.landlord_id AS landlord_id,b.property_id AS property_id,b.reference AS reference
     FROM hostel_messages m JOIN hostel_bookings b ON b.id = m.booking_id
     WHERE m.created_at >= ? ORDER BY m.created_at DESC LIMIT ?`,
    [since, MESSAGE_SCAN_LIMIT],
  ));
  for (const row of messages) {
    const content = String(row.content || "");
    if (!MOMO_PATTERN.test(content) || !MONEY_CONTEXT_PATTERN.test(content)) continue;
    await recordHostelSignal({
      signalKey: "off_platform_payment",
      severity: "MEDIUM",
      entityType: "MESSAGE",
      entityId: String(row.id),
      landlordId: String(row.landlord_id || ""),
      propertyId: String(row.property_id || ""),
      title: "Payment talk outside the platform",
      detail: `A ${String(row.sender_type || "").toLowerCase()} message on booking ${row.reference || row.booking_id} mentions paying outside UMaTeXPRESS.`,
      evidence: { bookingId: String(row.booking_id || ""), excerpt: content.slice(0, 200), sentAt: String(row.created_at || "") },
    });
    raised.push({ signalKey: "off_platform_payment", entityId: String(row.id), severity: "MEDIUM" });
  }

  // 7. Two landlords pointing payouts at the same masked account.
  const shared = rowsToObjects(await turso(
    `SELECT payout_bank_code, payout_account_last4, COUNT(*) AS landlords, GROUP_CONCAT(name) AS names
     FROM hostel_landlords
     WHERE COALESCE(payout_account_last4,'') <> ''
     GROUP BY payout_bank_code, payout_account_last4 HAVING landlords > 1`,
  ));
  for (const row of shared) {
    const key = `${row.payout_bank_code}:${row.payout_account_last4}`;
    await recordHostelSignal({
      signalKey: "shared_payout_account",
      severity: "LOW",
      entityType: "LANDLORD",
      entityId: key,
      title: "Payout account shared by landlords",
      detail: `${row.landlords} landlords point at an account ending ${row.payout_account_last4}. Confirm it is a shared ownership before paying.`,
      evidence: { landlords: Number(row.landlords || 0), names: String(row.names || "").split(","), bankCode: String(row.payout_bank_code || "") },
    });
    raised.push({ signalKey: "shared_payout_account", entityId: key, severity: "LOW" });
  }

  if (raised.length) await incrementMetric("hostel_signals_raised");
  logEvent("info", "hostel_signals_scanned", { raised: raised.length });
  const open = await listHostelSignals({ status: "OPEN" });
  return {
    scannedAt: now.toISOString(),
    raised: raised.length,
    open: open.length,
    bySeverity: {
      HIGH: open.filter((signal) => signal.severity === "HIGH").length,
      MEDIUM: open.filter((signal) => signal.severity === "MEDIUM").length,
      LOW: open.filter((signal) => signal.severity === "LOW").length,
    },
  };
}
