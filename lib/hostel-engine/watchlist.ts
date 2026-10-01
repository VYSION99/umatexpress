import { bedAvailableSql } from "./inventory";
import { ensureHostelResidencyTables } from "./residency";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { queueNotification } from "@/lib/notifications";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { ensureNotificationsTable, isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

const MAX_SAVED = 20;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hostel_saved_properties (
    id TEXT PRIMARY KEY,
    student_email TEXT NOT NULL,
    property_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    alert_enabled INTEGER NOT NULL DEFAULT 0,
    last_available INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(student_email, property_id, period_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_saved_student ON hostel_saved_properties(student_email, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_saved_alert ON hostel_saved_properties(alert_enabled, last_available, updated_at)",
  `CREATE TABLE IF NOT EXISTS hostel_new_period_alerts (
    watch_id TEXT NOT NULL, period_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (watch_id, period_id)
  )`,
];

let schemaReady: Promise<void> | null = null;
export function ensureHostelWatchlist() {
  schemaReady ??= (async () => {
    await ensureHostelTables();
    await ensureHostelResidencyTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelSavedProperties", version: "026_hostel_new_period_alerts", statements: SCHEMA });
  })().catch((error: unknown) => { schemaReady = null; throw error; });
  return schemaReady;
}

// Matches the public catalogue's approval, room, property and availability gates.
const AVAILABLE = `EXISTS (
  SELECT 1 FROM hostel_listings l
  JOIN hostel_spaces s ON s.id = l.space_id
  JOIN hostel_rooms r ON r.id = s.room_id
  JOIN hostel_properties p ON p.id = r.property_id
  JOIN hostel_periods pe ON pe.id = l.period_id
  WHERE p.id = w.property_id AND l.period_id = w.period_id
    AND COALESCE(pe.active,1) = 1 AND l.status = 'APPROVED'
    AND ${bedAvailableSql()}
    AND COALESCE(r.status,'ACTIVE') = 'ACTIVE'
    AND COALESCE(p.status,'DRAFT') <> 'SUSPENDED'
)`;

export type SavedHostel = { id: string; propertyId: string; periodId: string; name: string; periodName: string; alertEnabled: boolean; available: boolean; createdAt: string };
function view(row: Record<string, unknown>): SavedHostel {
  return {
    id: String(row.id || ""), propertyId: String(row.property_id || ""), periodId: String(row.period_id || ""),
    name: String(row.name || ""), periodName: String(row.period_name || ""),
    alertEnabled: Number(row.alert_enabled || 0) === 1, available: Number(row.available || 0) === 1,
    createdAt: String(row.created_at || ""),
  };
}

export async function listSavedHostels(email: string): Promise<SavedHostel[]> {
  await ensureHostelWatchlist();
  const rows = rowsToObjects(await turso(
    `SELECT w.id,w.property_id,w.period_id,w.alert_enabled,w.created_at,
      COALESCE(p.name,'Hostel unavailable') AS name,COALESCE(pe.name,'Academic year closed') AS period_name,
      CASE WHEN ${AVAILABLE} THEN 1 ELSE 0 END AS available
     FROM hostel_saved_properties w
     LEFT JOIN hostel_properties p ON p.id = w.property_id
     LEFT JOIN hostel_periods pe ON pe.id = w.period_id
     WHERE w.student_email = ? ORDER BY w.created_at DESC LIMIT ?`,
    [email.toLowerCase(), MAX_SAVED],
  ));
  return rows.map(view);
}

export async function saveHostel(email: string, propertyId: string, periodId: string) {
  await ensureHostelWatchlist();
  if (!propertyId || propertyId.length > 80 || !periodId || periodId.length > 80) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose an available hostel and academic year.", 400);
  }
  const address = email.toLowerCase();
  const existing = rowsToObjects(await turso("SELECT id FROM hostel_saved_properties WHERE student_email=? AND property_id=? AND period_id=? LIMIT 1", [address, propertyId, periodId]))[0];
  if (existing) return listSavedHostels(address);
  const valid = rowsToObjects(await turso(
    `SELECT p.id FROM hostel_properties p JOIN hostel_periods pe ON pe.id=? AND COALESCE(pe.active,1)=1
     WHERE p.id=? AND COALESCE(p.status,'DRAFT') <> 'SUSPENDED'
       AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id
         JOIN hostel_rooms r ON r.id=s.room_id WHERE r.property_id=p.id AND l.period_id=pe.id
           AND l.status='APPROVED' AND ${bedAvailableSql()}
           AND COALESCE(r.status,'ACTIVE')='ACTIVE') LIMIT 1`,
    [periodId, propertyId],
  ))[0];
  if (!valid) throw new CampusEngineError("NOT_FOUND", "That hostel is no longer available for this year.", 404);
  const stamp = new Date().toISOString();
  const inserted = await turso(
    `INSERT INTO hostel_saved_properties (id,student_email,property_id,period_id,last_available,created_at,updated_at)
     SELECT ?,?,?,?,1,?,? WHERE (SELECT COUNT(*) FROM hostel_saved_properties WHERE student_email=?) < ?
     ON CONFLICT(student_email,property_id,period_id) DO NOTHING`,
    [crypto.randomUUID(), address, propertyId, periodId, stamp, stamp, address, MAX_SAVED],
  );
  if (!Number(inserted.affected_row_count)) throw new CampusEngineError("CONFLICT", `Save up to ${MAX_SAVED} hostels. Remove one to add another.`, 409);
  return listSavedHostels(address);
}

export async function setHostelAlert(email: string, propertyId: string, periodId: string, enabled: boolean) {
  await ensureHostelWatchlist();
  const updated = await turso(
    `UPDATE hostel_saved_properties AS w SET alert_enabled=?,
      last_available=CASE WHEN ${AVAILABLE} THEN 1 ELSE 0 END, updated_at=?
     WHERE student_email=? AND property_id=? AND period_id=?`,
    [enabled ? 1 : 0, new Date().toISOString(), email.toLowerCase(), propertyId, periodId],
  );
  if (!Number(updated.affected_row_count)) throw new CampusEngineError("NOT_FOUND", "Save this hostel before enabling alerts.", 404);
  if (enabled) {
    // An academic year already on sale is the baseline, not a new alert.
    await turso(
      `INSERT OR IGNORE INTO hostel_new_period_alerts (watch_id,period_id,created_at)
       SELECT w.id,pe.id,? FROM hostel_saved_properties w
       JOIN hostel_periods old ON old.id=w.period_id
       JOIN hostel_periods pe ON pe.starts_on>old.starts_on AND COALESCE(pe.active,1)=1
       WHERE w.student_email=? AND w.property_id=? AND w.period_id=?
         AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id
           JOIN hostel_rooms r ON r.id=s.room_id WHERE r.property_id=w.property_id AND l.period_id=pe.id
             AND l.status='APPROVED' AND ${bedAvailableSql()}
             AND COALESCE(r.status,'ACTIVE')='ACTIVE')`,
      [new Date().toISOString(), email.toLowerCase(), propertyId, periodId],
    );
  }
  return listSavedHostels(email);
}

export async function removeSavedHostel(email: string, propertyId: string, periodId: string) {
  await ensureHostelWatchlist();
  await turso("DELETE FROM hostel_saved_properties WHERE student_email=? AND property_id=? AND period_id=?", [email.toLowerCase(), propertyId, periodId]);
  return listSavedHostels(email);
}

/** Dedicated cron, bounded to state changes. A held bed alone never triggers an alert. */
export async function scanHostelAvailability(limit = 12) {
  if (!(await isTursoConfiguredRuntime())) return { checked: 0, notified: 0 };
  await ensureHostelWatchlist();
  const candidates = rowsToObjects(await turso(
    `SELECT w.id,w.student_email,w.property_id,w.period_id,w.last_available,w.generation,
       COALESCE(p.name,'Hostel') AS name,COALESCE(pe.name,'academic year') AS period_name,
       CASE WHEN ${AVAILABLE} THEN 1 ELSE 0 END AS available
     FROM hostel_saved_properties w
     LEFT JOIN hostel_properties p ON p.id=w.property_id
     LEFT JOIN hostel_periods pe ON pe.id=w.period_id
     WHERE w.alert_enabled=1 AND w.last_available <> CASE WHEN ${AVAILABLE} THEN 1 ELSE 0 END
     ORDER BY w.updated_at ASC LIMIT ?`,
    [Math.min(Math.max(Math.floor(limit), 1), 20)],
  ));
  let notified = 0;
  for (const row of candidates) {
    const available = Number(row.available) === 1;
    const nextGeneration = Number(row.generation || 0) + (available ? 1 : 0);
    const claimed = await turso(
      "UPDATE hostel_saved_properties SET last_available=?,generation=?,updated_at=? WHERE id=? AND alert_enabled=1 AND last_available=?",
      [available ? 1 : 0, nextGeneration, new Date().toISOString(), String(row.id), Number(row.last_available)],
    );
    if (!Number(claimed.affected_row_count) || !available) continue;
    try {
      await ensureNotificationsTable();
      const savedId = String(row.id);
      const propertyId = String(row.property_id);
      const periodId = String(row.period_id);
      const link = `/hostel/${encodeURIComponent(propertyId)}?periodId=${encodeURIComponent(periodId)}`;
      const inserted = await queueNotification(turso, {
        recipient: String(row.student_email), template: "hostel_bed_available",
        subject: `${String(row.name)} has a bed available`,
        message: `A bed is available again at ${String(row.name)} for ${String(row.period_name)}. View it at ${link}. Availability can change before you book.`,
        reference: `hostel-watch:${savedId}:${nextGeneration}`, nowIso: new Date().toISOString(),
      });
      if (inserted) notified++;
    } catch (error) {
      // Retry on the next scan. The generation keeps a successfully queued
      // notification idempotent even if delivery is retried independently.
      await turso("UPDATE hostel_saved_properties SET last_available=0,updated_at=? WHERE id=? AND alert_enabled=1 AND generation=?", [new Date().toISOString(), String(row.id), nextGeneration]).catch(() => undefined);
      throw error;
    }
  }
  const yearAlerts = await scanNewHostelPeriods(limit);
  return { checked: candidates.length + yearAlerts.checked, notified: notified + yearAlerts.notified, newYearNotified: yearAlerts.notified };
}

/** Announce a newly bookable academic year once for each saved property. */
export async function scanNewHostelPeriods(limit = 12) {
  if (!(await isTursoConfiguredRuntime())) return { checked: 0, notified: 0 };
  await ensureHostelWatchlist();
  const candidates = rowsToObjects(await turso(
    `SELECT w.id AS watch_id,w.student_email,w.property_id,p.name AS property_name,
       pe.id AS period_id,pe.name AS period_name
     FROM hostel_saved_properties w
     JOIN hostel_properties p ON p.id=w.property_id AND COALESCE(p.status,'DRAFT')<>'SUSPENDED'
     JOIN hostel_periods old ON old.id=w.period_id
     JOIN hostel_periods pe ON pe.starts_on>old.starts_on AND COALESCE(pe.active,1)=1
     WHERE w.alert_enabled=1
       AND NOT EXISTS (SELECT 1 FROM hostel_new_period_alerts a WHERE a.watch_id=w.id AND a.period_id=pe.id)
       AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id
         JOIN hostel_rooms r ON r.id=s.room_id WHERE r.property_id=w.property_id AND l.period_id=pe.id
           AND l.status='APPROVED' AND ${bedAvailableSql()}
           AND COALESCE(r.status,'ACTIVE')='ACTIVE')
     ORDER BY pe.starts_on DESC,w.created_at ASC LIMIT ?`,
    [Math.min(Math.max(Math.floor(limit), 1), 20)],
  ));
  let notified = 0;
  for (const row of candidates) {
    const watchId = String(row.watch_id);
    const periodId = String(row.period_id);
    const claimed = await turso(
      `INSERT INTO hostel_new_period_alerts (watch_id,period_id,created_at) VALUES (?,?,?)
       ON CONFLICT(watch_id,period_id) DO NOTHING`,
      [watchId, periodId, new Date().toISOString()],
    );
    if (!Number(claimed.affected_row_count)) continue;
    try {
      await ensureNotificationsTable();
      const propertyId = String(row.property_id);
      const link = `/hostel/${encodeURIComponent(propertyId)}?periodId=${encodeURIComponent(periodId)}`;
      const inserted = await queueNotification(turso, {
        recipient: String(row.student_email), template: "hostel_year_open",
        subject: `${String(row.property_name)} has beds for ${String(row.period_name)}`,
        message: `${String(row.period_name)} is now open at ${String(row.property_name)}. View approved beds at ${link}. Availability may change before booking.`,
        reference: `hostel-year:${watchId}:${periodId}`, nowIso: new Date().toISOString(),
      });
      if (inserted) notified++;
    } catch (error) {
      await turso("DELETE FROM hostel_new_period_alerts WHERE watch_id=? AND period_id=?", [watchId, periodId]).catch(() => undefined);
      throw error;
    }
  }
  return { checked: candidates.length, notified };
}
