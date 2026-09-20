import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { rowsToObjects, turso } from "@/lib/turso";

/**
 * The academic-year catalogue.
 *
 * A period is the grain a bed is priced and booked against: a student books a
 * bed for one academic year, and a listing is one bed in one period. The
 * catalogue is admin-only, and a landlord may only price against an active
 * period, so "which years can be sold" has exactly one answer.
 *
 * This module also owns the payout-timing arithmetic the booking engine will
 * call in Phase 2: money leaves escrow three days before school reopens, and a
 * booking made so late that the window would be empty gets seven days instead.
 */

export type HostelPeriod = {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  active: boolean;
  createdAt: string;
};

/** School reopening, minus three days. */
/**
 * The year a student should land on when they did not pick one: the year in
 * progress, else the next to start, else the most recent in the catalogue. The
 * catalogue is sorted newest first, so "the first year" would open on an intake
 * that is two sessions away.
 */
export function defaultHostelPeriodId(periods: HostelPeriod[]): string | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const current = periods.find((period) => period.startsOn <= today && period.endsOn >= today);
  if (current) return current.id;
  const upcoming = periods.filter((period) => period.startsOn > today).sort((left, right) => left.startsOn.localeCompare(right.startsOn))[0];
  return upcoming?.id || periods[0]?.id;
}

export const RELEASE_LEAD_DAYS = 3;
/** The shortest escrow window a late booking can ever have. */
export const ESCROW_FLOOR_DAYS = 7;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_COLUMNS = "id,name,starts_on,ends_on,COALESCE(active,1) AS active,created_at";

function isoDate(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new CampusEngineError("VALIDATION_ERROR", `Give the ${label} as a date, like 2026-09-01.`, 400);
  }
  return text;
}

function periodView(row: Record<string, unknown>): HostelPeriod {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    startsOn: String(row.starts_on || ""),
    endsOn: String(row.ends_on || ""),
    active: Number(row.active ?? 1) === 1,
    createdAt: String(row.created_at || ""),
  };
}

/**
 * When the landlord's money may leave escrow for a booking confirmed at
 * `confirmedAt`: three days before the year starts, but never less than seven
 * days after the student paid, so a last-minute booking still has a real
 * dispute window.
 */
export function hostelReleaseAfter(startsOn: string, confirmedAt?: string) {
  const start = new Date(`${isoDate(startsOn, "start date")}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - RELEASE_LEAD_DAYS);
  const byPeriod = start.toISOString().slice(0, 10);
  const confirmed = confirmedAt ? new Date(confirmedAt) : null;
  if (!confirmed || Number.isNaN(confirmed.getTime())) return byPeriod;
  confirmed.setUTCDate(confirmed.getUTCDate() + ESCROW_FLOOR_DAYS);
  const byEscrow = confirmed.toISOString().slice(0, 10);
  return byEscrow > byPeriod ? byEscrow : byPeriod;
}

export async function getHostelPeriod(periodId: string): Promise<HostelPeriod> {
  await ensureHostelTables();
  const row = rowsToObjects(await turso(`SELECT ${PERIOD_COLUMNS} FROM hostel_periods WHERE id = ? LIMIT 1`, [periodId]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That academic year was not found.", 404);
  return periodView(row);
}

/** The catalogue: students see the open years, staff see the whole history. */
export async function listHostelPeriods(options: { includeInactive?: boolean } = {}): Promise<HostelPeriod[]> {
  await ensureHostelTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${PERIOD_COLUMNS} FROM hostel_periods ${options.includeInactive ? "" : "WHERE COALESCE(active,1) = 1"} ORDER BY starts_on DESC`,
  ));
  return rows.map(periodView);
}

export async function getActiveHostelPeriod(): Promise<HostelPeriod | null> {
  await ensureHostelTables();
  const row = rowsToObjects(await turso(
    `SELECT ${PERIOD_COLUMNS} FROM hostel_periods WHERE COALESCE(active,1) = 1 ORDER BY starts_on DESC LIMIT 1`,
  ))[0];
  return row ? periodView(row) : null;
}

/**
 * Adds a year to the catalogue. Two open years may not overlap: a bed priced
 * against an ambiguous year is a pricing bug waiting for a student to find it.
 */
export async function createHostelPeriod(actor: string, input: {
  name?: unknown; startsOn?: unknown; endsOn?: unknown;
}): Promise<HostelPeriod> {
  await ensureHostelTables();
  const name = String(input.name ?? "").trim();
  if (name.length < 8 || name.length > 60) {
    throw new CampusEngineError("VALIDATION_ERROR", "Name the year between 8 and 60 characters, like 2026/27 Academic Year.", 400);
  }
  const startsOn = isoDate(input.startsOn, "start date");
  const endsOn = isoDate(input.endsOn, "end date");
  if (startsOn >= endsOn) {
    throw new CampusEngineError("VALIDATION_ERROR", "The year has to end after it starts.", 400);
  }

  const clash = rowsToObjects(await turso(
    "SELECT id,name FROM hostel_periods WHERE COALESCE(active,1) = 1 AND starts_on <= ? AND ends_on >= ? LIMIT 1",
    [endsOn, startsOn],
  ))[0];
  if (clash) {
    throw new CampusEngineError("CONFLICT", `Those dates overlap ${String(clash.name)}. Close that year first or pick dates that do not overlap.`, 409);
  }

  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await turso(
    "INSERT INTO hostel_periods (id,name,starts_on,ends_on,active,created_at) VALUES (?,?,?,?,1,?)",
    [id, name, startsOn, endsOn, stamp],
  );
  await consoleAudit({
    actor,
    action: "HOSTEL_PERIOD_CREATED",
    targetType: "hostel_period",
    targetReference: id,
    details: { name, startsOn, endsOn, releaseAfter: hostelReleaseAfter(startsOn) },
  }).catch(() => undefined);
  return getHostelPeriod(id);
}

/** Closes a year to new listings without touching the listings it already holds. */
export async function closeHostelPeriod(actor: string, periodId: string): Promise<HostelPeriod> {
  const period = await getHostelPeriod(periodId);
  if (!period.active) return period;
  await turso("UPDATE hostel_periods SET active = 0 WHERE id = ?", [periodId]);
  await consoleAudit({
    actor,
    action: "HOSTEL_PERIOD_CLOSED",
    targetType: "hostel_period",
    targetReference: periodId,
    details: { name: period.name },
  }).catch(() => undefined);
  return { ...period, active: false };
}
